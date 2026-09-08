import logging
import secrets

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import hash_password
from backend.config import settings
from backend.models import AppSetting, User, UserRole

logger = logging.getLogger(__name__)


async def bootstrap_initial_admin(db: AsyncSession) -> bool:
    """Create the initial administrator for a brand-new installation."""

    # If any users already exist, this installation has already been initialized.
    result = await db.execute(select(func.count()).select_from(User))
    user_count = result.scalar_one()

    if user_count > 0:
        return False

    # Blank identity values fall back to the safe built-in defaults.  The
    # password remains optional so first-run setup can collect it interactively.
    username = settings.INITIAL_ADMIN_USERNAME.strip() or "Admin"
    display_name = settings.INITIAL_ADMIN_DISPLAY_NAME.strip() or "Administrator"
    configured_password = settings.INITIAL_ADMIN_PASSWORD

    # Match the same basic validation used by AdminUserCreate.
    if not 2 <= len(username) <= 50:
        logger.error(
            "INITIAL_ADMIN_USERNAME must be between 2 and 50 characters."
        )
        return False

    if configured_password and len(configured_password) < 6:
        logger.error(
            "INITIAL_ADMIN_PASSWORD must be at least 6 characters."
        )
        return False

    if not 1 <= len(display_name) <= 30:
        logger.error(
            "INITIAL_ADMIN_DISPLAY_NAME must be between 1 and 30 characters."
        )
        return False

    admin = User(
        username=username,
        display_name=display_name,
        # Keep the existing non-null password_hash schema while ensuring that
        # an unset initial password is not usable or known to anyone.
        password_hash=hash_password(
            configured_password or secrets.token_urlsafe(32)
        ),
        role=UserRole.admin,
    )

    setup_setting = AppSetting(
        key="initial_setup_complete",
        value="false",
    )
    password_setup_setting = AppSetting(
        key="initial_password_setup_required",
        value="true" if not configured_password else "false",
    )

    db.add(admin)
    db.add(setup_setting)
    db.add(password_setup_setting)

    await db.commit()

    logger.info(
        "Initial administrator '%s' created successfully.",
        username,
    )

    return True
