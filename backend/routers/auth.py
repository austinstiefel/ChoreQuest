from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import get_db
from backend.models import User, UserRole, RefreshToken, AuditLog, AppSetting
from backend.seed import seed_database
from backend.schemas import (
    LoginRequest,
    InitialPasswordSetupRequest,
    PinLoginRequest,
    ChangePasswordRequest,
    SetPinRequest,
    UpdateProfileRequest,
    UserResponse,
    AuthResponse,
)
from backend.auth import (
    hash_password,
    verify_password,
    hash_pin,
    verify_pin,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    hash_token,
)
from backend.dependencies import get_current_user
from backend.rate_limit import rate_limiter
from backend.websocket_manager import ws_manager

router = APIRouter(prefix="/api/auth", tags=["auth"])

REFRESH_COOKIE_NAME = "refresh_token"
SETUP_COMPLETE_KEY = "initial_setup_complete"
INITIAL_PASSWORD_SETUP_REQUIRED_KEY = "initial_password_setup_required"


def _set_refresh_cookie(response: Response, token: str):
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        path="/api/auth",
        secure=settings.COOKIE_SECURE,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )


def _clear_refresh_cookie(response: Response):
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path="/api/auth",
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
    )


async def _issue_tokens(
    user: User, db: AsyncSession, response: Response
) -> AuthResponse:
    access_token = create_access_token(user.id, user.role.value)
    raw_refresh, expires_at = create_refresh_token(user.id)

    stored = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_refresh),
        expires_at=expires_at,
    )
    db.add(stored)
    await db.commit()

    _set_refresh_cookie(response, raw_refresh)

    return AuthResponse(
        access_token=access_token,
        user=UserResponse.model_validate(user),
    )

# ---------- GET /setup-status ----------
@router.get("/setup-status")
async def get_setup_status(
    db: AsyncSession = Depends(get_db),
):
    """Return whether the initial administrator setup has been completed."""

    result = await db.execute(
        select(User)
        .where(
            User.role == UserRole.admin,
            User.is_active == True,
        )
        .order_by(User.id)
    )
    admin = result.scalars().first()

    if admin is None:
        return {
            "setup_required": True,
            "admin_username": None,
            "password_setup_required": False,
        }

    setting_result = await db.execute(
        select(AppSetting).where(AppSetting.key == SETUP_COMPLETE_KEY)
    )
    setting = setting_result.scalar_one_or_none()

    password_setup_result = await db.execute(
        select(AppSetting).where(
            AppSetting.key == INITIAL_PASSWORD_SETUP_REQUIRED_KEY
        )
    )
    password_setup_setting = password_setup_result.scalar_one_or_none()

    setup_complete = setting is not None and setting.value == "true"
    password_setup_required = (
        not setup_complete
        and password_setup_setting is not None
        and password_setup_setting.value == "true"
    )

    return {
        "setup_required": not setup_complete,
        "admin_username": admin.username,
        "password_setup_required": password_setup_required,
    }


# ---------- POST /setup-password ----------
@router.post("/setup-password", response_model=AuthResponse)
async def setup_initial_password(
    body: InitialPasswordSetupRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Set the password for the password-less bootstrap administrator once."""

    rate_limiter.check(f"setup-password:{request.client.host}", 5, 900)

    if body.password != body.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")

    setup_result = await db.execute(
        select(AppSetting).where(AppSetting.key == SETUP_COMPLETE_KEY)
    )
    setup_setting = setup_result.scalar_one_or_none()
    password_setup_result = await db.execute(
        select(AppSetting).where(
            AppSetting.key == INITIAL_PASSWORD_SETUP_REQUIRED_KEY
        )
    )
    password_setup_setting = password_setup_result.scalar_one_or_none()

    if (
        setup_setting is None
        or setup_setting.value != "false"
        or password_setup_setting is None
        or password_setup_setting.value != "true"
    ):
        raise HTTPException(
            status_code=400,
            detail="Initial password setup is not available",
        )

    admin_result = await db.execute(
        select(User)
        .where(User.role == UserRole.admin, User.is_active == True)
        .order_by(User.id)
    )
    admins = admin_result.scalars().all()
    if len(admins) != 1:
        raise HTTPException(
            status_code=400,
            detail="Initial administrator setup is not available",
        )

    admin = admins[0]
    admin.password_hash = hash_password(body.password)
    admin.updated_at = datetime.now(timezone.utc)

    # The conditional update makes the one-time transition safe if two setup
    # requests arrive concurrently.
    transition = await db.execute(
        update(AppSetting)
        .where(
            AppSetting.key == SETUP_COMPLETE_KEY,
            AppSetting.value == "false",
        )
        .values(value="true")
    )
    if transition.rowcount != 1:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Initial password setup is no longer available",
        )

    password_setup_setting.value = "false"
    db.add(
        AuditLog(
            user_id=admin.id,
            action="initial_password_setup",
            details={},
            ip_address=request.client.host if request.client else None,
        )
    )
    await db.commit()

    return await _issue_tokens(admin, db, response)

# ---------- POST /login ----------
@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"login:{request.client.host}", 10, 300)

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Audit log
    audit = AuditLog(
        user_id=user.id,
        action="login",
        details={"method": "password"},
        ip_address=request.client.host if request.client else None,
    )
    db.add(audit)

    # Mark the initial administrator setup as complete after
    # the first successful administrator login.
    if user.role == UserRole.admin:
        setting_result = await db.execute(
            select(AppSetting).where(AppSetting.key == SETUP_COMPLETE_KEY)
        )
        setting = setting_result.scalar_one_or_none()

        if setting is not None and setting.value == "false":
            setting.value = "true"

    await db.commit()

    return await _issue_tokens(user, db, response)


# ---------- POST /pin-login ----------
@router.post("/pin-login", response_model=AuthResponse)
async def pin_login(
    body: PinLoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"pin:{request.client.host}", 5, 900)

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if user is None or user.pin_hash is None or not verify_pin(body.pin, user.pin_hash):
        raise HTTPException(status_code=401, detail="Invalid username or PIN")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Audit log
    audit = AuditLog(
        user_id=user.id,
        action="login",
        details={"method": "pin"},
        ip_address=request.client.host if request.client else None,
    )
    db.add(audit)
    await db.commit()

    return await _issue_tokens(user, db, response)


# ---------- POST /refresh ----------
@router.post("/refresh", response_model=AuthResponse)
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not raw_token:
        raise HTTPException(status_code=401, detail="No refresh token")

    payload = decode_refresh_token(raw_token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    user_id = int(payload["sub"])
    token_hash_value = hash_token(raw_token)

    result = await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash_value)
    )
    stored = result.scalar_one_or_none()

    if stored is None:
        raise HTTPException(status_code=401, detail="Refresh token not found")

    if stored.is_revoked:
        resp = JSONResponse({"detail": "Refresh token already used"}, status_code=401)
        _clear_refresh_cookie(resp)
        return resp

    # Load user
    user_result = await db.execute(
        select(User).where(User.id == user_id, User.is_active == True)
    )
    user = user_result.scalar_one_or_none()
    if user is None:
        resp = JSONResponse({"detail": "User not found or inactive"}, status_code=401)
        _clear_refresh_cookie(resp)
        return resp

    # Rotate: revoke old token, issue a fresh pair
    stored.is_revoked = True

    access_token = create_access_token(user.id, user.role.value)
    new_raw_refresh, new_expires_at = create_refresh_token(user.id)
    new_stored = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(new_raw_refresh),
        expires_at=new_expires_at,
    )
    db.add(new_stored)
    await db.commit()

    _set_refresh_cookie(response, new_raw_refresh)

    return AuthResponse(
        access_token=access_token,
        user=UserResponse.model_validate(user),
    )


# ---------- POST /logout ----------
@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw_token:
        token_hash_value = hash_token(raw_token)
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash_value)
        )
        stored = result.scalar_one_or_none()
        if stored and not stored.is_revoked:
            stored.is_revoked = True
            await db.commit()

    _clear_refresh_cookie(response)
    return {"detail": "Logged out"}


# ---------- GET /me ----------
@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)):
    return UserResponse.model_validate(user)


# ---------- PUT /me ----------
@router.put("/me", response_model=UserResponse)
async def update_me(
    body: UpdateProfileRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.avatar_config is not None:
        user.avatar_config = body.avatar_config

    user.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    await ws_manager.broadcast({"type": "data_changed", "data": {"entity": "user"}}, exclude_user=user.id)
    return UserResponse.model_validate(user)


# ---------- POST /change-password ----------
@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    user.password_hash = hash_password(body.new_password)
    user.updated_at = datetime.now(timezone.utc)

    # Invalidate all refresh tokens
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user.id,
            RefreshToken.is_revoked == False,
        )
    )
    for tok in result.scalars().all():
        tok.is_revoked = True

    # Audit log
    audit = AuditLog(
        user_id=user.id,
        action="password_change",
        details={},
        ip_address=request.client.host if request.client else None,
    )
    db.add(audit)
    await db.commit()

    return {"detail": "Password changed. Please log in again."}


# ---------- POST /set-pin ----------
@router.post("/set-pin")
async def set_pin(
    body: SetPinRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.pin_hash = hash_pin(body.pin)
    user.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"detail": "PIN set successfully"}
