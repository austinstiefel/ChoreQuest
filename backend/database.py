from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.schema import CreateTable
from sqlalchemy.dialects import sqlite
from backend.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def _migrate_nullable_user_refs():
    """Make user creator/actor references nullable without losing rows.

    SQLite requires affected tables to be rebuilt for this schema change. The
    rebuild recreates constraints represented by the current SQLAlchemy
    metadata and copies all existing columns/rows. Separately-defined custom
    indexes or triggers are not copied, so the migration refuses to run if
    any are present on an affected table.
    """
    nullable_user_refs = {
        "chores": ["created_by"],
        "rewards": ["created_by"],
        "seasonal_events": ["created_by"],
        "api_keys": ["created_by"],
        "invite_codes": ["created_by"],
        "shoutouts": ["from_user_id", "to_user_id"],
        "announcements": ["created_by"],
        "vacation_periods": ["created_by"],
    }

    async with engine.connect() as conn:
        fk_result = await conn.exec_driver_sql("PRAGMA foreign_keys")
        original_foreign_keys = bool(fk_result.scalar_one())

        tables_to_rebuild = []
        existing_columns_by_table = {}
        for table_name, nullable_columns in nullable_user_refs.items():
            result = await conn.exec_driver_sql(f'PRAGMA table_info("{table_name}")')
            existing_columns = {row[1]: row[3] for row in result.fetchall()}
            existing_columns_by_table[table_name] = existing_columns

            if any(existing_columns.get(column) == 1 for column in nullable_columns):
                tables_to_rebuild.append(table_name)

        # A second run has nothing to rebuild and must not open a migration
        # transaction or change the connection's foreign-key setting.
        if not tables_to_rebuild:
            return

        table_list = ", ".join(f'"{table_name}"' for table_name in tables_to_rebuild)
        custom_objects = await conn.exec_driver_sql(
            "SELECT type, name, tbl_name "
            "FROM sqlite_master "
            f"WHERE tbl_name IN ({table_list}) "
            "AND type IN ('index', 'trigger') "
            "AND name NOT LIKE 'sqlite_autoindex_%'"
        )
        custom_objects = custom_objects.fetchall()
        if custom_objects:
            object_names = ", ".join(
                f"{object_type} {name}" for object_type, name, _ in custom_objects
            )
            raise RuntimeError(
                "Cannot rebuild nullable user-reference tables because custom "
                f"SQLite schema objects are present: {object_names}"
            )

        # PRAGMA foreign_keys is a connection setting and cannot be changed
        # after a transaction begins. Use AUTOCOMMIT for the setting change,
        # then explicitly begin the transactional rebuild.
        await conn.rollback()
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        await conn.rollback()
        conn = await conn.execution_options(isolation_level="SERIALIZABLE")

        try:
            async with conn.begin():
                current_foreign_keys = await conn.exec_driver_sql(
                    "PRAGMA foreign_keys"
                )
                if bool(current_foreign_keys.scalar_one()):
                    raise RuntimeError(
                        "Could not disable SQLite foreign-key enforcement for migration"
                    )

                for table_name in tables_to_rebuild:
                    table = Base.metadata.tables[table_name]
                    existing_columns = existing_columns_by_table[table_name]
                    temp_name = f"{table_name}__nullable_user_refs"
                    create_sql = str(CreateTable(table).compile(dialect=sqlite.dialect()))
                    create_sql = create_sql.replace(
                        f"CREATE TABLE {table_name}",
                        f'CREATE TABLE "{temp_name}"',
                        1,
                    )

                    await conn.exec_driver_sql(f'DROP TABLE IF EXISTS "{temp_name}"')
                    await conn.exec_driver_sql(create_sql)

                    columns = [
                        column.name
                        for column in table.columns
                        if column.name in existing_columns
                    ]
                    quoted_columns = ", ".join(
                        f'"{column}"' for column in columns
                    )
                    await conn.exec_driver_sql(
                        f'INSERT INTO "{temp_name}" ({quoted_columns}) '
                        f'SELECT {quoted_columns} FROM "{table_name}"'
                    )
                    await conn.exec_driver_sql(f'DROP TABLE "{table_name}"')
                    await conn.exec_driver_sql(
                        f'ALTER TABLE "{temp_name}" RENAME TO "{table_name}"'
                    )

                violations = (
                    await conn.exec_driver_sql("PRAGMA foreign_key_check")
                ).fetchall()
                if violations:
                    raise RuntimeError(
                        "Nullable user-reference migration found "
                        f"{len(violations)} foreign-key violation(s)"
                    )
        finally:
            # The transaction context rolls back automatically on failure.
            # Restore the connection's original setting only after that
            # transaction has ended.
            await conn.rollback()
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.exec_driver_sql(
                "PRAGMA foreign_keys="
                + ("ON" if original_foreign_keys else "OFF")
            )
            await conn.rollback()


async def init_db():
    async with engine.begin() as conn:
        # Enable WAL mode
        await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
        from backend.models import (  # noqa: F401
            User, Chore, ChoreAssignment, ChoreCategory, ChoreRotation,
            ChoreExclusion, ChoreAssignmentRule, QuestTemplate,
            Reward, RewardRedemption, PointTransaction,
            Achievement, UserAchievement, WishlistItem, SeasonalEvent,
            Notification, SpinResult, ApiKey, AuditLog, AppSetting,
            InviteCode, RefreshToken, PushSubscription,
            AvatarItem, UserAvatarItem,
            Shoutout, VacationPeriod,
        )
        await conn.run_sync(Base.metadata.create_all)

        # Lightweight column migrations for SQLite (create_all won't add
        # new columns to existing tables).
        _migrations = [
            ("reward_redemptions", "fulfilled_by", "INTEGER REFERENCES users(id)"),
            ("reward_redemptions", "fulfilled_at", "DATETIME"),
            # v2 feature columns
            ("users", "streak_freezes_used", "INTEGER DEFAULT 0"),
            ("users", "streak_freeze_month", "INTEGER"),
            ("chore_assignments", "feedback", "TEXT"),
            ("rewards", "category", "VARCHAR(50)"),
            ("achievements", "tier", "VARCHAR(10)"),
            ("achievements", "group_key", "VARCHAR(50)"),
            ("achievements", "sort_order", "INTEGER DEFAULT 0"),
        ]
        for table, col, typedef in _migrations:
            try:
                await conn.exec_driver_sql(
                    f"ALTER TABLE {table} ADD COLUMN {col} {typedef}"
                )
            except Exception:
                pass  # column already exists

    await _migrate_nullable_user_refs()


async def get_db():
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()
