import type { Prisma } from "@prisma/client";
import { requireSafeUserIds } from "../db/accountSchema.js";
import { sqliteTimestamp } from "../db/legacySqlite.js";

/** Modeled defaults for fixtures; production writes use insertAccount's UTC text. */
export function newUserData(input: {
	username: string;
	displayName: string;
	passwordHash: string;
	role: string;
}): Prisma.usersUncheckedCreateInput {
	const now = new Date();
	return {
		username: input.username, display_name: input.displayName,
		password_hash: input.passwordHash, pin_hash: null, role: input.role,
		points_balance: 0, total_points_earned: 0, current_streak: 0, longest_streak: 0,
		last_streak_date: null, streak_freezes_used: 0, streak_freeze_month: null,
		is_active: true, created_at: now, updated_at: now,
	};
}

/** Caller holds the SQLite writer transaction; IDs are allocated by AUTOINCREMENT. */
export async function insertAccount(tx: Prisma.TransactionClient, input: Parameters<typeof newUserData>[0]): Promise<number> {
	await requireSafeUserIds(tx);
	const now = sqliteTimestamp();
	await tx.$executeRaw`
    INSERT INTO users (username, display_name, password_hash, pin_hash, role,
      points_balance, total_points_earned, current_streak, longest_streak,
      last_streak_date, streak_freezes_used, streak_freeze_month, avatar_config,
      is_active, created_at, updated_at)
    VALUES (${input.username}, ${input.displayName}, ${input.passwordHash}, NULL, ${input.role},
      0, 0, 0, 0, NULL, 0, NULL, NULL, 1, ${now}, ${now})
  `;
	const [row] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT last_insert_rowid() AS id`;
	return Number(row.id);
}
