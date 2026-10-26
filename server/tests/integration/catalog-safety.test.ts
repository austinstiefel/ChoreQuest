import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterEach, expect, it } from "vitest";
import { seedBusinessData } from "../../src/business/seed.js";
import { seedCatalogue } from "../../src/business/seedCatalogue.js";
import { Store, tables, type Table } from "../../src/business/store.js";
import { requireDeletionSchema } from "../../src/db/accountSchema.js";
import { newUserData } from "../../src/auth/accounts.js";
import { disposableDatabase } from "../helpers/sqlite.js";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const identifier = (name: string) => Prisma.raw(`"${name.replaceAll('"', '""')}"`);
/** quote() snapshots the exact SQL values, including JSON whitespace and six
 * fractional digits, rather than hiding changes behind normalized ORM reads. */
async function snapshot(prisma: PrismaClient) {
	const result = new Map<Table, Array<Record<string, string>>>();
	for (const table of tables) {
		const columns = await prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`PRAGMA table_info(${identifier(table)})`);
		result.set(table, await prisma.$queryRaw<Array<Record<string, string>>>(Prisma.sql`SELECT ${Prisma.join(columns.map(c => Prisma.sql`quote(${identifier(c.name)}) AS ${identifier(c.name)}`))} FROM ${identifier(table)} ORDER BY ${identifier(table === "app_settings" ? "key" : "id")}`));
	}
	return result;
}
it.each([false, true])("preserves all populated rows and schedules through repeated catalogue startup (legacy=%s)", async legacy => {
	const db = await disposableDatabase(legacy);cleanup.push(() => db.dispose());
	let prisma = db.prisma, store = await Store.open(prisma);
	const admin = await prisma.users.create({ data: { ...newUserData({ username: "ExistingAdmin", displayName: "Custom", role: "admin", passwordHash: "test-only-existing-password" }), pin_hash: "test-only-existing-pin", points_balance: 345, total_points_earned: 999, current_streak: 3, longest_streak: 7 } });
	const kid = await prisma.users.create({ data: newUserData({ username: "ExistingKid", displayName: "Kid", role: "kid", passwordHash: "test-only" }) });
	await store.update("users", admin.id, { avatar_config: { pet: "cat", pet_xp_map: { cat: 72 }, pet_interactions: { date: "2030-01-01", count: 3 }, custom: "preserve" } });
	const category = await store.insert("chore_categories", { name: seedCatalogue.DEFAULT_QUESTS[0].category, icon: "custom", colour: "#abcdef", is_default: false, created_at: "2001-01-01 00:00:00.123456" });
	const secondCategory = seedCatalogue.DEFAULT_QUESTS.find(q => q.category !== seedCatalogue.DEFAULT_QUESTS[0].category)!.category;
	await store.insert("chore_categories",{name:secondCategory,icon:"custom",colour:"#123456",is_default:false});
	const chore = await store.insert("chores", { title: seedCatalogue.DEFAULT_QUESTS[0].title, description: "Customized quest", points: 777, difficulty: "expert", icon: "custom", category_id: category.id, recurrence: "custom", custom_days: [1, 3], requires_photo: true, is_active: true, created_by: admin.id, created_at: "2001-01-01 00:00:00.123456", updated_at: "2001-01-01 00:00:00.654321" });
	await store.insert("chore_assignment_rules", { chore_id: chore.id, user_id: kid.id, recurrence: "fortnightly", custom_days: [1, 3], requires_photo: true, is_active: true, created_at: "2001-01-01 00:00:00.123456", updated_at: "2001-01-01 00:00:00.123456" });
	await store.insert("chore_rotations", { chore_id: chore.id, kid_ids: [kid.id, admin.id], cadence: "monthly", current_index: 1, last_rotated: "2030-01-01 01:02:03.456789" });
	await store.insert("chore_assignments", { chore_id: chore.id, user_id: kid.id, date: "2030-01-01", status: "verified", completed_at: "2030-01-01 01:02:03.123456", verified_at: "2030-01-01 01:03:04.654321", verified_by: admin.id, photo_proof_path: "fixture-only.png", feedback: "Keep history" });
	await store.insert("chore_exclusions", { chore_id: chore.id, user_id: kid.id, date: "2030-01-03" });
	await store.insert("vacation_periods", { start_date: "2030-02-01", end_date: "2030-02-07", is_active: true, created_by: admin.id });
	const achievement = await store.insert("achievements", { ...seedCatalogue.DEFAULT_ACHIEVEMENTS[0], title: "Custom achievement", points_reward: 1234, criteria: { type: "total_completions", count: 777 }, tier: "custom", group_key: "custom", sort_order: 999 });
	await store.insert("user_achievements", { user_id: kid.id, achievement_id: achievement.id, unlocked_at: "2030-01-01 03:04:05.987654" });
	await store.insert("rewards", { title: "Customized reward", description: "Do not replace", point_cost: 888, icon: null, category: null, stock: 2, auto_approve_threshold: 3, is_active: false, created_by: admin.id });
	await store.insert("quest_templates", { title: "Custom template", description: "Keep", suggested_points: 666, difficulty: "expert", category_name: "Custom", icon: null });
	const avatar = await store.insert("avatar_items", { category: "head", item_id: "round", display_name: "Custom round", rarity: "epic", unlock_method: "shop", unlock_value: 456, is_default: false });
	await store.insert("user_avatar_items", { user_id: kid.id, avatar_item_id: avatar.id, acquired_via: "purchase" });
	for (const [key, value] of Object.entries({ daily_reset_hour: "17", spin_wheel_enabled: "false", initial_setup_complete: "true", initial_password_setup_required: "false", vapid_private_key: "synthetic-private-fixture", custom_setting: "retain" })) await prisma.$executeRaw`INSERT INTO app_settings (key,value,updated_at) VALUES (${key},${value},'2001-01-01 00:00:00.123456')`;
	if (legacy) {
		await prisma.$disconnect();const source = await readFile(db.databasePath), prepared = resolve(db.directory, "prepared.db");
		await execute(resolve(root, "../.venv/Scripts/python.exe"), ["-B", resolve(root, "scripts/prepare-legacy-auth-db.py"), "--source", db.databasePath, "--output", prepared], { windowsHide: true });
		expect(await readFile(db.databasePath)).toEqual(source);
		prisma = new PrismaClient({ datasources: { db: { url: `file:${prepared.replaceAll("\\", "/")}?connection_limit=1` } } });
		cleanup.push(() => prisma.$disconnect());store = await Store.open(prisma);
	}
	await requireDeletionSchema(prisma);
	const before = await snapshot(prisma);
	await seedBusinessData(prisma);
	const first = await snapshot(prisma);
	for (const [table, rows] of before) for (const row of rows) {
		const key = table === "app_settings" ? "key" : "id";
		expect(first.get(table)!.find(r => r[key] === row[key]), `${table} existing ${row[key]}`).toEqual(row);
	}
	expect(first.get("achievements")!.length).toBe(seedCatalogue.DEFAULT_ACHIEVEMENTS.length);
	expect(first.get("chores")!.length).toBeGreaterThan(before.get("chores")!.length);
	expect(first.get("avatar_items")).toEqual(before.get("avatar_items"));
	expect(first.get("quest_templates")).toEqual(before.get("quest_templates"));
	expect((await store.rows("app_settings")).find(s => s.key === "assignment_rules_cleanup_v1")).toBeUndefined();
	await seedBusinessData(prisma);await seedBusinessData(prisma);
	expect(await snapshot(prisma)).toEqual(first);
	expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
}, 20000);
