"""Read-only source snapshot and copy-only preparation audit; never runs cutover.

Retains private disposable databases outside the repository for review/smoke tests.
Reports only schema names, counts, file fingerprints and validation booleans.
"""

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile


helpers = runpy.run_path(str(Path(__file__).with_name("prepare-legacy-auth-db.py")))
quote = helpers["quote"]


def readonly(path):
    connection = sqlite3.connect(Path(path).resolve(strict=True).as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def fingerprints(path):
    result = {}
    for suffix in ("", "-wal", "-shm"):
        file = Path(str(path) + suffix)
        if file.exists():
            stat = file.stat()
            with file.open("rb") as content:
                digest = hashlib.file_digest(content, "sha256").hexdigest()
            result[suffix or "main"] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": digest}
        else:
            result[suffix or "main"] = None
    return result


def snapshot(source, output):
    with Path(output).open("xb"):
        pass
    with closing(readonly(source)) as original, closing(sqlite3.connect(output)) as target:
        original.backup(target)
        integrity(target)


def integrity(connection):
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or connection.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Database integrity verification failed")


def compare(source, prepared):
    with closing(readonly(source)) as old, closing(readonly(prepared)) as new:
        integrity(old)
        integrity(new)
        tables = [row[0] for row in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        if tables != [row[0] for row in new.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]:
            raise ValueError("Table inventory mismatch")
        counts, changed_columns, changed_ddl, normalized = {}, {}, [], 0
        for table in tables:
            names = [row[1] for row in old.execute(f"PRAGMA table_info({quote(table)})")]
            original = old.execute(f"SELECT * FROM {quote(table)} ORDER BY rowid").fetchall()
            expected = [helpers["normalize_row"](table, names, row) for row in original]
            normalized += sum(a != b for row, converted in zip(original, expected) for a, b in zip(row, converted))
            if new.execute(f"SELECT {','.join(map(quote, names))} FROM {quote(table)} ORDER BY rowid").fetchall() != expected:
                raise ValueError("Row transformation mismatch")
            counts[table] = len(expected)
            old_columns = old.execute(f"PRAGMA table_info({quote(table)})").fetchall()
            new_columns = {row[1]: row for row in new.execute(f"PRAGMA table_info({quote(table)})")}
            changed_columns[table] = [a[1] for a in old_columns if a[1:] != new_columns[a[1]][1:]]
            normalized_fks = sorted((column, parent, reference, update,
                "SET NULL" if parent == "users" and column in helpers["NULLABLE_REFS"].get(table, set()) and deletion in ("NO ACTION", "SET NULL") else deletion, match)
                for column, parent, reference, update, deletion, match in helpers["foreign_keys"](old, table))
            if normalized_fks != helpers["foreign_keys"](new, table):
                raise ValueError("Unexpected foreign-key relationship change")
            old_ddl = old.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()[0]
            new_ddl = new.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()[0]
            if old_ddl != new_ddl:
                changed_ddl.append(table)
        objects_sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','view','trigger') AND sql IS NOT NULL ORDER BY type,name"
        target_objects = {(row[0], row[1]): row for row in new.execute(objects_sql)}
        for row in old.execute(objects_sql):
            if target_objects.get((row[0], row[1])) != row:
                raise ValueError("Named schema object mismatch")
        for table in tables:
            if helpers["unique_keys"](old, table) != helpers["unique_keys"](new, table):
                raise ValueError("Unique constraint mismatch")
        if old.execute("SELECT id,role,is_active FROM users ORDER BY id").fetchall() != new.execute("SELECT id,role,is_active FROM users ORDER BY id").fetchall():
            raise ValueError("Account identity/administrator preservation failed")
        # Actual SQLAlchemy Date/DateTime processors, not just string inspection.
        from sqlalchemy import Column, Date, DateTime, MetaData, Table, create_engine, select
        engine = create_engine("sqlite://", creator=lambda: readonly(prepared))
        checked = 0
        try:
            for name in tables:
                if name == "_prisma_migrations":
                    continue
                date_columns = [Column(row[1], Date if row[2].upper() == "DATE" else DateTime)
                    for row in new.execute(f"PRAGMA table_info({quote(name)})") if row[2].upper() in ("DATE", "DATETIME")]
                if date_columns:
                    table = Table(name, MetaData(), *date_columns)
                    with engine.connect() as connection:
                        for _ in connection.execute(select(table)):
                            checked += 1
        finally:
            engine.dispose()
        return {"integrity_check": "ok", "foreign_key_check": "clean", "application_tables": len([t for t in tables if t != "_prisma_migrations"]),
            "row_counts": counts, "all_rows_verified": True, "account_ids_and_roles_preserved": True,
            "named_schema_objects_preserved": True, "unique_constraints_preserved": True,
            "internal_unique_index_names_canonicalized": True, "changed_table_definitions": changed_ddl,
            "changed_column_metadata": {name: cols for name, cols in changed_columns.items() if cols},
            "normalized_timestamp_values": normalized, "sqlalchemy_rows_read": checked}


def verify_source(report):
    after = fingerprints(report["source"])
    # SHM is volatile reader coordination, not persisted database content.
    unchanged = all(after[key] == report["source_before"][key] for key in ("main", "-wal"))
    return {"main_and_wal_unchanged": unchanged,
        "shm_unchanged": after["-shm"] == report["source_before"]["-shm"], "after": after}


def run(source):
    source = Path(source).resolve(strict=True)
    before = fingerprints(source)
    directory = Path(tempfile.mkdtemp(prefix="chorequest-legacy-dry-run-"))
    files = {name: directory / f"{name}.db" for name in ("snapshot", "prepared", "baseline", "exercise")}
    snapshot(source, files["snapshot"])
    with closing(readonly(files["snapshot"])) as connection:
        source_schema = {key: connection.execute(f"PRAGMA {key}").fetchone()[0] for key in ("schema_version", "user_version", "application_id", "journal_mode")}
        source_schema["prisma_history_present"] = bool(connection.execute("SELECT 1 FROM sqlite_master WHERE name='_prisma_migrations'").fetchone())
    helpers["prepare"](files["snapshot"], files["prepared"])
    verification = compare(files["snapshot"], files["prepared"])
    snapshot(files["prepared"], files["baseline"])
    snapshot(files["prepared"], files["exercise"])
    report = {"source": str(source), "workspace": str(directory), "source_before": before,
        "source_schema": source_schema, "files": {name: str(path) for name, path in files.items()}, "verification": verification}
    report["source_preservation"] = verify_source(report)
    with (directory / "report.json").open("x", encoding="utf8") as output:
        json.dump(report, output, indent=2)
    if not report["source_preservation"]["main_and_wal_unchanged"]:
        raise ValueError("Source changed during the snapshot window; do not claim unchanged content")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--source")
    group.add_argument("--verify-source", help="Private workspace report.json from an earlier run")
    args = parser.parse_args()
    if args.verify_source:
        report = json.loads(Path(args.verify_source).read_text(encoding="utf8"))
        result = verify_source(report)
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result["main_and_wal_unchanged"] else 1)
    report = run(args.source)
    print(json.dumps({"workspace": report["workspace"], "source_schema": report["source_schema"],
        "verification": report["verification"], "source_preservation": report["source_preservation"]}, indent=2))
