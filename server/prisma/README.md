# Prisma database baseline

The existing ChoreQuest SQLite database is the source of truth for this
schema. The baseline migration was generated from the introspected Prisma
schema so that a new database can be created with the same logical tables,
columns, constraints, and foreign-key actions.

The baseline migration is not intended to be run against an existing
`data/chores_os.db` file. Before using Prisma migrations on an existing
database, make a verified backup and mark this baseline as applied with
`prisma migrate resolve --applied 00000000000000_baseline` only after the
database has been compared with `schema.prisma`.

Future schema changes should be made in `schema.prisma`, reviewed with
`prisma migrate diff`, and generated as a new migration. Never use
`prisma migrate reset` for an existing ChoreQuest database.

SQLite JSON-declared columns are represented as
`Unsupported("json")` because Prisma 6 cannot expose SQLite JSON columns
through Prisma Client's typed model API. Their existing JSON text is preserved
and can be read or written with parameterized Prisma raw SQL until a later
application-level JSON strategy is selected.
