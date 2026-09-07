import logging

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

    # No users exist, so we need the initial admin configuration.
    missing = []

    if not settings.INITIAL_ADMIN_USERNAME.strip():
        missing.append("INITIAL_ADMIN_USERNAME")

    if not settings.INITIAL_ADMIN_PASSWORD:
        missing.append("INITIAL_ADMIN_PASSWORD")

    if not settings.INITIAL_ADMIN_DISPLAY_NAME.strip():
        missing.append("INITIAL_ADMIN_DISPLAY_NAME")

    if missing:
        logger.error(
            "No users exist and the initial administrator has not been configured. "
            "Add the following variables to the .env file and restart ChoreQuest: %s",
            ", ".join(missing),
        )
        return False

    # Match the same basic validation used by AdminUserCreate.
    if not 2 <= len(settings.INITIAL_ADMIN_USERNAME) <= 50:
        logger.error(
            "INITIAL_ADMIN_USERNAME must be between 2 and 50 characters."
        )
        return False

    if len(settings.INITIAL_ADMIN_PASSWORD) < 6:
        logger.error(
            "INITIAL_ADMIN_PASSWORD must be at least 6 characters."
        )
        return False

    if not 1 <= len(settings.INITIAL_ADMIN_DISPLAY_NAME) <= 30:
        logger.error(
            "INITIAL_ADMIN_DISPLAY_NAME must be between 1 and 30 characters."
        )
        return False

    admin = User(
        username=settings.INITIAL_ADMIN_USERNAME,
        display_name=settings.INITIAL_ADMIN_DISPLAY_NAME,
        password_hash=hash_password(settings.INITIAL_ADMIN_PASSWORD),
        role=UserRole.admin,
    )

    setup_setting = AppSetting(
        key="initial_setup_complete",
        value="false",
    )

    db.add(admin)
    db.add(setup_setting)

    await db.commit()

    logger.info(
        "Initial administrator '%s' created successfully.",
        settings.INITIAL_ADMIN_USERNAME,
    )

    return True