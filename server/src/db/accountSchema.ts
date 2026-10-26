import { Prisma } from "@prisma/client";

export const NULLABLE_USER_REFERENCES: ReadonlyArray<readonly [string, string]> = [
	["chore_assignments", "verified_by"], ["reward_redemptions", "approved_by"],
	["reward_redemptions", "fulfilled_by"], ["point_transactions", "created_by"],
	["audit_logs", "user_id"], ["shoutouts", "from_user_id"], ["shoutouts", "to_user_id"],
	...["chores", "rewards", "seasonal_events", "api_keys", "invite_codes", "announcements", "vacation_periods"]
		.map((table) => [table, "created_by"] as const),
];

export class AccountSchemaError extends Error {
	constructor() {
		super("Account schema upgrade required. Stop the application and follow server/prisma/README.md; no automatic migration was performed.");
	}
}

/** Fail closed on legacy ROWID allocation, including repository calls without startup. */
export async function requireSafeUserIds(db: Prisma.TransactionClient): Promise<void> {
	const rows = await db.$queryRaw<Array<{ sql: string }>>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`;
	if (rows[0] === undefined || !/\bAUTOINCREMENT\b/i.test(rows[0].sql)) throw new AccountSchemaError();
}

/** Check every preserved creator/actor link before touching any account data. */
export async function requireDeletionSchema(db: Prisma.TransactionClient): Promise<void> {
	await requireSafeUserIds(db);
	for (const [table, column] of NULLABLE_USER_REFERENCES) {
		const columns = await db.$queryRaw<Array<{ name: string; notnull: bigint }>>(Prisma.sql`PRAGMA table_info(${Prisma.raw(table)})`);
		const reference = columns.find((entry) => entry.name === column);
		if (reference === undefined || Boolean(reference.notnull)) throw new AccountSchemaError();
	}
}
