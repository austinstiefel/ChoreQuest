"""Offline SQLite/upload/config backup and NEW-directory restore. No live restore.

The caller must stop writers for cross-resource consistency. SQLite backup() also
captures committed WAL pages; copying the .db file alone is insufficient.
"""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3


def absolute(path):
    value = Path(path)
    if not value.is_absolute():
        raise ValueError("Absolute paths required")
    return value


def integrity(path):
    with closing(sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("SQLite integrity check failed")


def inventory(directory):
    result = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("Symlinks are not supported in recovery state")
        if path.is_file() and path != directory / "manifest.json":
            with path.open("rb") as contents:
                result[path.relative_to(directory).as_posix()] = hashlib.file_digest(contents, "sha256").hexdigest()
    return result


def snapshot(database, uploads, output, configuration=None):
    database, uploads, output = map(absolute, (database, uploads, output))
    database = database.resolve(strict=True)
    uploads = uploads.resolve(strict=True)
    output = output.resolve()
    if output == uploads or uploads in output.parents or output in uploads.parents or output in database.parents:
        raise ValueError("Backup must be outside source state")
    if not uploads.is_dir():
        raise ValueError("Uploads must be a directory")
    inventory(uploads)  # Reject symlinks before creating the destination.
    output.mkdir(mode=0o700)  # Exclusive: never overwrite a backup.
    try:
        target = output / "chorequest.db"
        with target.open("xb"):
            pass
        target.chmod(0o600)
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(target)) as destination:
            source.execute("PRAGMA query_only=ON")
            source.backup(destination)
        integrity(target)
        shutil.copytree(uploads, output / "uploads")
        if configuration:
            config = absolute(configuration)
            if config.is_symlink() or not config.is_file():
                raise ValueError("Configuration must be a regular file")
            shutil.copyfile(config, output / "configuration.env")
        # Restrict all copied files as well as the enclosing backup directory.
        for path in output.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        manifest = {"format": 1, "files": inventory(output)}
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        (output / "manifest.json").chmod(0o600)
    except BaseException:
        shutil.rmtree(output)
        raise


def restore(backup, output):
    backup, output = absolute(backup).resolve(strict=True), absolute(output).resolve()
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1 or inventory(backup) != manifest.get("files"):
        raise ValueError("Backup manifest mismatch")
    integrity(backup / "chorequest.db")
    if backup == output or backup in output.parents or output in backup.parents:
        raise ValueError("Restore must be outside backup state")
    # copytree refuses an existing destination. It never overwrites live state.
    shutil.copytree(backup, output)
    output.chmod(0o700)
    integrity(output / "chorequest.db")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--restore-from")
    parser.add_argument("--database")
    parser.add_argument("--uploads")
    parser.add_argument("--configuration")
    parser.add_argument("--writers-stopped", action="store_true")
    args = parser.parse_args()
    if args.restore_from:
        if args.database or args.uploads or args.configuration:
            parser.error("Restore accepts only a backup and new output directory")
        restore(args.restore_from, args.output)
    else:
        if not args.writers_stopped or not args.database or not args.uploads:
            parser.error("Stop writers, then provide --writers-stopped --database --uploads")
        snapshot(args.database, args.uploads, args.output, args.configuration)
    print("Recovery state verified; no existing destination overwritten")


if __name__ == "__main__":
    # Never print exceptions containing copied private state or configuration.
    try:
        main()
    except Exception:
        raise SystemExit("Recovery operation failed; verify paths, permissions and integrity privately")
