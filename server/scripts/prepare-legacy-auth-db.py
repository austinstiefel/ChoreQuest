"""Offline, copy-only SQLite auth upgrade. Never opens the source for writing.

The source is its own rollback backup. An existing output is never overwritten.
Foreign keys stay enabled; deferred checks permit copying parent/child rows.
The replacement uses the reviewed Prisma baseline, after checking equivalent
legacy columns/constraints. Nullable actor FKs become SET NULL. Named indexes,
triggers and views are retained; internal unique indexes acquire baseline names.
Unknown constraints/schema differences fail closed. The source is never changed.
"""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import sqlite3


NULLABLE_REFS = {
    "chores": {"created_by"}, "rewards": {"created_by"},
    "seasonal_events": {"created_by"}, "api_keys": {"created_by"},
    "invite_codes": {"created_by"}, "announcements": {"created_by"},
    "vacation_periods": {"created_by"}, "shoutouts": {"from_user_id", "to_user_id"},
    "chore_assignments": {"verified_by"},
    "reward_redemptions": {"approved_by", "fulfilled_by"},
    "point_transactions": {"created_by"}, "audit_logs": {"user_id"},
}
AUTH_TIMESTAMPS = {
    "users": {"created_at", "updated_at"}, "app_settings": {"updated_at"},
    "refresh_tokens": {"created_at", "expires_at"},
    "api_keys": {"created_at", "last_used_at"},
    "invite_codes": {"created_at", "expires_at"}, "audit_logs": {"created_at"},
}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def normalize_row(table, names, row):
    values = list(row)
    for index, name in enumerate(names):
        if name in AUTH_TIMESTAMPS.get(table, set()) and isinstance(values[index], (int, float)):
            # Prisma's native SQLite engine stores DateTime as epoch milliseconds.
            instant = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=values[index])
            values[index] = instant.strftime("%Y-%m-%d %H:%M:%S.%f")
    return tuple(values)


def unique_keys(db, table, full_only=False):
    return {tuple(row[2] for row in db.execute(f"PRAGMA index_info({quote(index[1])})"))
        for index in db.execute(f"PRAGMA index_list({quote(table)})") if index[2] and (not full_only or not index[4])}


def foreign_keys(db, table):
    return sorted((row[3], row[2], row[4], row[5], row[6], row[7])
        for row in db.execute(f"PRAGMA foreign_key_list({quote(table)})"))


def checked_baseline(snapshot):
    """Accept only demonstrated legacy differences; never discard custom constraints."""
    baseline = sqlite3.connect(":memory:")
    baseline.execute("PRAGMA foreign_keys=ON")
    sql = (Path(__file__).resolve().parents[1] / "prisma/migrations/00000000000000_baseline/migration.sql").read_text(encoding="utf8")
    baseline.executescript(sql)  # Only reviewed repository SQL, on an empty scratch DB.
    tables = baseline.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    expected_names = {name for name, _ in tables}
    source_names = {row[0] for row in snapshot.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if source_names - {"_prisma_migrations"} != expected_names:
        baseline.close()
        raise ValueError("Unknown/missing application tables; manual schema review required")
    try:
        for table, _ in tables:
            ddl = snapshot.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()[0]
            if re.search(r"\b(CHECK|COLLATE|GENERATED|DEFERRABLE|WITHOUT|STRICT)\b", ddl, re.I):
                raise ValueError("Custom table constraints require manual schema review")
            old = {row[1]: row for row in snapshot.execute(f"PRAGMA table_info({quote(table)})")}
            new = {row[1]: row for row in baseline.execute(f"PRAGMA table_info({quote(table)})")}
            if old.keys() != new.keys():
                raise ValueError("Column inventory mismatch; manual schema review required")
            def affinity(value):
                value = value.upper()
                if "INT" in value:
                    return "INTEGER"
                if any(word in value for word in ("CHAR", "CLOB", "TEXT")):
                    return "TEXT"
                if any(word in value for word in ("REAL", "FLOA", "DOUB")):
                    return "REAL"
                return value if value in ("", "BLOB") else "NUMERIC"
            for column, previous in old.items():
                current = new[column]
                nullable_change = column in NULLABLE_REFS.get(table, set()) and not current[3]
                if affinity(previous[2]) != affinity(current[2]) or previous[4:] != current[4:] or (previous[3] != current[3] and not nullable_change):
                    raise ValueError("Unsupported type/default/constraint difference")
            target_keys = unique_keys(baseline, table)
            if not target_keys.issubset(unique_keys(snapshot, table, full_only=True)):
                raise ValueError("Source lacks a required unique constraint")
            for index in snapshot.execute(f"PRAGMA index_list({quote(table)})"):
                key = tuple(row[2] for row in snapshot.execute(f"PRAGMA index_info({quote(index[1])})"))
                if index[3] == "u" and key not in target_keys:
                    raise ValueError("Custom inline unique constraint requires manual review")
            normalized = [(column, parent, reference, update,
                "SET NULL" if parent == "users" and column in NULLABLE_REFS.get(table, set()) and deletion in ("NO ACTION", "SET NULL") else deletion, match)
                for column, parent, reference, update, deletion, match in foreign_keys(snapshot, table)]
            if sorted(normalized) != foreign_keys(baseline, table):
                raise ValueError("Unexpected foreign-key difference")
        return baseline, tables
    except BaseException:
        baseline.close()
        raise


def prepare(source, output):
    source, output = Path(source).resolve(strict=True), Path(output).resolve()
    if source == output:
        raise ValueError("Source and output must be different files")
    # O_EXCL semantics: never truncate/replace a pre-existing output or source.
    with output.open("xb"):
        pass
    target = snapshot = original = baseline = None
    try:
        original = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
        original.execute("PRAGMA query_only=ON")
        snapshot = sqlite3.connect(":memory:")
        original.backup(snapshot)
        original.close()
        original = None
        if snapshot.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or snapshot.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Source integrity check failed; repair/review separately")
        objects = snapshot.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").fetchall()
        tables = [(name, sql) for kind, name, sql in objects if kind == "table"]
        if "users" not in dict(tables):
            raise ValueError("Not a provisioned ChoreQuest database")
        baseline, canonical_tables = checked_baseline(snapshot)
        target = sqlite3.connect(output)
        target.execute("PRAGMA foreign_keys=ON")
        target.execute("BEGIN IMMEDIATE")
        target.execute("PRAGMA defer_foreign_keys=ON")
        for name, sql in canonical_tables:
            target.execute(sql)
        if "_prisma_migrations" in dict(tables):
            target.execute(dict(tables)["_prisma_migrations"])
        copied = {}
        for name, _ in tables:
            names = [row[1] for row in snapshot.execute(f"PRAGMA table_info({quote(name)})")]
            rows = [normalize_row(name, names, row) for row in snapshot.execute(f"SELECT * FROM {quote(name)} ORDER BY rowid")]
            target.executemany(f"INSERT INTO {quote(name)} ({','.join(map(quote, names))}) VALUES ({','.join('?' for _ in names)})", rows)
            copied[name] = (names, rows)
        # Preserve previous high-water marks when the source already used AUTOINCREMENT.
        if snapshot.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
            for name, sequence in snapshot.execute("SELECT name, seq FROM sqlite_sequence"):
                if target.execute("SELECT 1 FROM sqlite_sequence WHERE name = ?", (name,)).fetchone():
                    target.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?", (sequence, name))
                else:
                    # Empty tables have no new sequence row, but their deleted IDs
                    # must remain reserved (particularly an empty users table).
                    target.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, sequence))
        canonical_indexes = baseline.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").fetchall()
        for _, sql in canonical_indexes:
            target.execute(sql)
        for kind in ("index", "view", "trigger"):
            for object_kind, name, sql in objects:
                if object_kind == kind:
                    if kind == "index":
                        canonical_sql = dict(canonical_indexes).get(name)
                        if canonical_sql is not None:
                            normalize = lambda value: re.sub(r'[\s"`\[\]]', '', value).lower().rstrip(';')
                            if normalize(sql) != normalize(canonical_sql):
                                raise ValueError("Conflicting named index requires manual review")
                            continue
                    target.execute(sql)
        for name, (names, rows) in copied.items():
            if target.execute(f"SELECT {','.join(map(quote, names))} FROM {quote(name)} ORDER BY rowid").fetchall() != rows:
                raise ValueError("Row verification failed")
        for table, columns in NULLABLE_REFS.items():
            info = {row[1]: row[3] for row in target.execute(f"PRAGMA table_info({quote(table)})")}
            if any(info.get(column, 1) for column in columns):
                raise ValueError("Unsupported nullable reference definition; manual schema review required")
        if target.execute("PRAGMA foreign_key_check").fetchall() or target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Output integrity check failed")
        target.commit()
        target.close()
        target = None
        # Read back committed results before declaring the replacement verified.
        with closing(sqlite3.connect(output.as_uri() + "?mode=ro", uri=True)) as check:
            if check.execute("PRAGMA foreign_key_check").fetchall() or check.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Committed output integrity check failed")
        return len(tables)
    except BaseException:
        if target is not None:
            target.rollback()
            target.close()
            target = None
        output.unlink(missing_ok=True)  # Only the exclusive new output owned by this call.
        raise
    finally:
        if original is not None:
            original.close()
        if snapshot is not None:
            snapshot.close()
        if baseline is not None:
            baseline.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True, help="New file only; source is never modified")
    args = parser.parse_args()
    try:
        count = prepare(args.source, args.output)
    except (ValueError, sqlite3.Error, OSError):
        parser.exit(1, "Upgrade failed; source unchanged. Review schema/integrity and use a new output path.\n")
    print(f"Verified replacement: {count} tables, preserved rows, clean foreign keys.")
    print("Before activating a legacy upgrade: stop all writers, retain the source backup, and rotate SECRET_KEY on every backend to invalidate pre-upgrade sessions. See server/prisma/README.md.")
