import { Prisma, type PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { newUserData } from "../../src/auth/accounts.js";
import { createAccessToken } from "../../src/auth/tokens.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { createAdminRouter, createPrismaAdminRepository } from "../../src/routes/admin.js";
import { createPrismaAuthRepository } from "../../src/routes/auth.js";
import { disposableDatabase } from "../helpers/sqlite.js";

let db: Awaited<ReturnType<typeof disposableDatabase>>;
beforeEach(async () => { db = await disposableDatabase(); });
afterEach(async () => { await db.dispose(); });

// Test fixture builder using the actual baseline's required columns. Identifiers
// and overrides below are test constants; no development data is ever copied.
async function fixture(prisma: PrismaClient, table: string, overrides: Record<string, string | number | null> = {}) {
	const columns = await prisma.$queryRaw<Array<{ name: string; type: string; notnull: bigint; pk: bigint }>>(Prisma.sql`PRAGMA table_info(${Prisma.raw(table)})`);
	const values: Record<string, string | number | null> = {};
	for (const column of columns) {
		if (column.pk || !column.notnull) continue;
		values[column.name] = /INT|REAL|BOOL|FLOAT/i.test(column.type) ? 0 : /DATE/i.test(column.type) ? "2030-01-01 00:00:00" : column.type.toLowerCase() === "json" ? "[]" : `fixture-${column.name}`;
	}
	Object.assign(values, overrides);
	await prisma.$executeRaw(Prisma.sql`INSERT INTO ${Prisma.raw(table)}
    (${Prisma.join(Object.keys(values).map((key) => Prisma.raw(key)))})
    VALUES (${Prisma.join(Object.values(values))})`);
	const [row] = await prisma.$queryRaw<Array<{ id: bigint }>>`SELECT last_insert_rowid() AS id`;
	return Number(row.id);
}

it("permanently deletes every user-owned relationship while preserving family and historical records", async () => {
	const prisma = db.prisma;
	const makeUser = (username: string, role: string) => prisma.users.create({ data: newUserData({ username, role, displayName: username, passwordHash: "test-only-unusable-hash" }) });
	const admin = await makeUser("Admin", "admin");
	const owner = await makeUser("Deleted", "kid");
	const survivor = await makeUser("Survivor", "kid");
	const category = await fixture(prisma, "chore_categories");
	const chore = await fixture(prisma, "chores", { category_id: category, created_by: owner.id });
	const reward = await fixture(prisma, "rewards", { created_by: owner.id });
	const achievement = await fixture(prisma, "achievements");
	const avatar = await fixture(prisma, "avatar_items");
	const owned = {
		refresh_tokens: {}, chore_assignments: { chore_id: chore }, chore_exclusions: { chore_id: chore },
		chore_assignment_rules: { chore_id: chore }, reward_redemptions: { reward_id: reward },
		point_transactions: {}, user_achievements: { achievement_id: achievement }, wishlist_items: {},
		notifications: {}, spin_results: {}, push_subscriptions: {}, user_avatar_items: { avatar_item_id: avatar },
	};
	for (const [table, extra] of Object.entries(owned)) await fixture(prisma, table, { user_id: owner.id, ...extra });
	const assignment = await fixture(prisma, "chore_assignments", { chore_id: chore, user_id: survivor.id, verified_by: owner.id });
	const redemption = await fixture(prisma, "reward_redemptions", { reward_id: reward, user_id: survivor.id, approved_by: owner.id, fulfilled_by: owner.id });
	const points = await fixture(prisma, "point_transactions", { user_id: survivor.id, created_by: owner.id });
	const outgoing = await fixture(prisma, "shoutouts", { from_user_id: owner.id, to_user_id: survivor.id });
	const incoming = await fixture(prisma, "shoutouts", { from_user_id: survivor.id, to_user_id: owner.id });
	const audit = await fixture(prisma, "audit_logs", { user_id: owner.id });
	const rotation = await fixture(prisma, "chore_rotations", { chore_id: chore, kid_ids: JSON.stringify([owner.id, survivor.id]) });
	for (const table of ["seasonal_events", "api_keys", "invite_codes", "announcements", "vacation_periods"]) {
		await fixture(prisma, table, { created_by: owner.id });
	}
	const config = loadAuthConfig({ SECRET_KEY: "deletion-fixture-test-secret" });
	const auth = createPrismaAuthRepository(prisma);
	const app = createApp(undefined, config, createAdminRouter({ config, auth, repository: createPrismaAdminRepository(prisma) }));
	await request(app).delete(`/api/admin/users/${owner.id}`)
		.set("Authorization", `Bearer ${await createAccessToken(admin.id, "admin", config)}`)
		.expect(200, { detail: "User permanently deleted" });
	for (const table of Object.keys(owned)) {
		const rows = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM ${Prisma.raw(table)} WHERE user_id = ${owner.id}`);
		expect(rows, table).toHaveLength(0);
	}
	expect(await prisma.users.findUnique({ where: { id: owner.id } })).toBeNull();
	expect(await prisma.users.findUnique({ where: { id: survivor.id } })).not.toBeNull();
	expect(await prisma.chore_assignments.findUnique({ where: { id: assignment } })).toMatchObject({ user_id: survivor.id, verified_by: null });
	expect(await prisma.reward_redemptions.findUnique({ where: { id: redemption } })).toMatchObject({ user_id: survivor.id, approved_by: null, fulfilled_by: null });
	expect(await prisma.point_transactions.findUnique({ where: { id: points } })).toMatchObject({ user_id: survivor.id, created_by: null });
	expect(await prisma.shoutouts.findUnique({ where: { id: outgoing } })).toMatchObject({ from_user_id: null, to_user_id: survivor.id });
	expect(await prisma.shoutouts.findUnique({ where: { id: incoming } })).toMatchObject({ from_user_id: survivor.id, to_user_id: null });
	expect(await prisma.audit_logs.findUnique({ where: { id: audit } })).toMatchObject({ user_id: null });
	for (const table of ["chores", "rewards", "seasonal_events", "api_keys", "invite_codes", "announcements", "vacation_periods"]) {
		const rows = await prisma.$queryRaw<Array<{ created_by: number | null }>>(Prisma.sql`SELECT created_by FROM ${Prisma.raw(table)}`);
		expect(rows, table).toEqual([{ created_by: null }]);
	}
	const [remainingRotation] = await prisma.$queryRaw<Array<{ kid_ids: string }>>`SELECT kid_ids FROM chore_rotations WHERE id = ${rotation}`;
	expect(JSON.parse(remainingRotation.kid_ids)).toEqual([survivor.id]);
	expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
});

it("rolls back all deletion changes when the final user deletion fails", async () => {
	const prisma = db.prisma;
	const admin = await prisma.users.create({ data: newUserData({ username: "Admin", displayName: "Admin", passwordHash: "test-only", role: "admin" }) });
	const user = await prisma.users.create({ data: newUserData({ username: "Kid", displayName: "Kid", passwordHash: "test-only", role: "kid" }) });
	const notification = await fixture(prisma, "notifications", { user_id: user.id });
	const announcement = await fixture(prisma, "announcements", { created_by: user.id });
	await prisma.$executeRawUnsafe("CREATE TRIGGER fail_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
	await expect(createPrismaAdminRepository(prisma).deleteUser(user.id, admin.id)).rejects.toThrow();
	expect(await prisma.users.findUnique({ where: { id: user.id } })).not.toBeNull();
	expect(await prisma.notifications.findUnique({ where: { id: notification } })).not.toBeNull();
	expect(await prisma.announcements.findUnique({ where: { id: announcement } })).toMatchObject({ created_by: user.id });
});
