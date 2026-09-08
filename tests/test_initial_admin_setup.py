import unittest

from pydantic import ValidationError
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from starlette.requests import Request
from starlette.responses import Response

from backend.auth import verify_password
from backend.bootstrap import bootstrap_initial_admin
from backend.config import settings
from backend.database import Base
from backend.models import AppSetting, User, UserRole
from backend.routers.auth import (
    get_setup_status,
    login,
    setup_initial_password,
)
from backend.schemas import InitialPasswordSetupRequest, LoginRequest


class InitialAdminSetupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        self.session_factory = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        self.original_settings = (
            settings.INITIAL_ADMIN_USERNAME,
            settings.INITIAL_ADMIN_PASSWORD,
            settings.INITIAL_ADMIN_DISPLAY_NAME,
        )

    async def asyncTearDown(self):
        (
            settings.INITIAL_ADMIN_USERNAME,
            settings.INITIAL_ADMIN_PASSWORD,
            settings.INITIAL_ADMIN_DISPLAY_NAME,
        ) = self.original_settings
        await self.engine.dispose()

    def configure_initial_admin(
        self,
        username="",
        password="",
        display_name="",
    ):
        settings.INITIAL_ADMIN_USERNAME = username
        settings.INITIAL_ADMIN_PASSWORD = password
        settings.INITIAL_ADMIN_DISPLAY_NAME = display_name

    @staticmethod
    def request(host):
        return Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/auth/setup-password",
                "headers": [],
                "client": (host, 12345),
                "scheme": "http",
            }
        )

    async def get_user_and_settings(self, session):
        user = (await session.execute(select(User))).scalar_one()
        app_settings = {
            row.key: row.value
            for row in (await session.execute(select(AppSetting))).scalars()
        }
        return user, app_settings

    async def test_no_environment_values_use_defaults_and_require_password_setup(self):
        self.configure_initial_admin()

        async with self.session_factory() as session:
            self.assertTrue(await bootstrap_initial_admin(session))
            user, app_settings = await self.get_user_and_settings(session)

            self.assertEqual(user.username, "Admin")
            self.assertEqual(user.display_name, "Administrator")
            self.assertEqual(user.role, UserRole.admin)
            self.assertTrue(app_settings["initial_setup_complete"] == "false")
            self.assertTrue(
                app_settings["initial_password_setup_required"] == "true"
            )
            self.assertFalse(verify_password("unknown-password", user.password_hash))

            status = await get_setup_status(session)
            self.assertEqual(
                status,
                {
                    "setup_required": True,
                    "admin_username": "Admin",
                    "password_setup_required": True,
                },
            )

    async def test_configured_password_supports_normal_first_run_login(self):
        self.configure_initial_admin(
            username="ConfiguredAdmin",
            password="ConfiguredPassword1",
            display_name="Configured Administrator",
        )

        async with self.session_factory() as session:
            self.assertTrue(await bootstrap_initial_admin(session))
            user, app_settings = await self.get_user_and_settings(session)
            self.assertTrue(verify_password("ConfiguredPassword1", user.password_hash))
            self.assertEqual(
                app_settings["initial_password_setup_required"], "false"
            )

            response = Response()
            auth_response = await login(
                LoginRequest(
                    username="ConfiguredAdmin",
                    password="ConfiguredPassword1",
                ),
                self.request("configured-login"),
                response,
                session,
            )

            self.assertEqual(auth_response.user.username, "ConfiguredAdmin")
            status = await get_setup_status(session)
            self.assertFalse(status["setup_required"])
            self.assertFalse(status["password_setup_required"])

    async def test_password_setup_succeeds_and_authenticates_admin(self):
        self.configure_initial_admin()

        async with self.session_factory() as session:
            await bootstrap_initial_admin(session)
            auth_response = await setup_initial_password(
                InitialPasswordSetupRequest(
                    password="NewAdminPassword1",
                    confirm_password="NewAdminPassword1",
                ),
                self.request("setup-success"),
                Response(),
                session,
            )

            user, app_settings = await self.get_user_and_settings(session)
            self.assertEqual(auth_response.user.username, "Admin")
            self.assertTrue(verify_password("NewAdminPassword1", user.password_hash))
            self.assertEqual(app_settings["initial_setup_complete"], "true")
            self.assertEqual(
                app_settings["initial_password_setup_required"], "false"
            )
            self.assertFalse((await get_setup_status(session))["setup_required"])

    async def test_password_setup_rejects_mismatched_passwords(self):
        self.configure_initial_admin()

        async with self.session_factory() as session:
            await bootstrap_initial_admin(session)
            with self.assertRaises(HTTPException) as context:
                await setup_initial_password(
                    InitialPasswordSetupRequest(
                        password="NewAdminPassword1",
                        confirm_password="DifferentPassword1",
                    ),
                    self.request("setup-mismatch"),
                    Response(),
                    session,
                )
            self.assertEqual(context.exception.status_code, 400)
            self.assertEqual(context.exception.detail, "Passwords do not match")

            settings_row = (
                await session.execute(
                    select(AppSetting).where(
                        AppSetting.key == "initial_setup_complete"
                    )
                )
            ).scalar_one()
            self.assertEqual(settings_row.value, "false")

    async def test_password_setup_rejects_too_short_password(self):
        with self.assertRaises(ValidationError):
            InitialPasswordSetupRequest(
                password="short",
                confirm_password="short",
            )

    async def test_password_setup_is_one_time_only(self):
        self.configure_initial_admin()

        async with self.session_factory() as session:
            await bootstrap_initial_admin(session)
            await setup_initial_password(
                InitialPasswordSetupRequest(
                    password="NewAdminPassword1",
                    confirm_password="NewAdminPassword1",
                ),
                self.request("setup-once"),
                Response(),
                session,
            )

            with self.assertRaises(HTTPException) as context:
                await setup_initial_password(
                    InitialPasswordSetupRequest(
                        password="AnotherPassword1",
                        confirm_password="AnotherPassword1",
                    ),
                    self.request("setup-after-complete"),
                    Response(),
                    session,
                )
            self.assertEqual(context.exception.status_code, 400)
            self.assertEqual(
                context.exception.detail,
                "Initial password setup is not available",
            )

            user = (await session.execute(select(User))).scalar_one()
            self.assertTrue(verify_password("NewAdminPassword1", user.password_hash))


if __name__ == "__main__":
    unittest.main()
