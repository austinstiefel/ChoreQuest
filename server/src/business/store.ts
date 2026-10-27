import { Prisma, type PrismaClient } from "@prisma/client";
import { sqliteDate, sqliteTimestamp } from "../db/legacySqlite.js";
export type Row = Record<string, unknown>;
export type Database = Prisma.TransactionClient;
export const tables = ["users", "chore_categories", "chores", "chore_assignments", "chore_assignment_rules", "chore_rotations", "chore_exclusions", "quest_templates", "rewards", "reward_redemptions", "point_transactions", "achievements", "user_achievements", "notifications", "avatar_items", "user_avatar_items", "spin_results", "wishlist_items", "seasonal_events", "announcements", "shoutouts", "vacation_periods", "app_settings", "audit_logs", "push_subscriptions"] as const;
export type Table = typeof tables[number];
type Column = {
	name: string;
	type: string;
};
const dateOnly: Partial<Record<Table, string[]>> = { users: ["last_streak_date"], chore_assignments: ["date"], chore_exclusions: ["date"], spin_results: ["spin_date"], vacation_periods: ["start_date", "end_date"] };
const identifier = (name: string) => Prisma.raw(`"${name.replaceAll('"', '""')}"`);
function utcTimestamp(value: string | number | Date): string {
	const date = sqliteDate(value).toISOString();
	// JavaScript Date only retains milliseconds. Preserve the original SQLite
	// microseconds for responses/history when a text timestamp supplies them.
	const fraction = typeof value === "string" && /^\d{4}-\d\d-\d\d[ T]/.test(value) ? /\.(\d{1,6})(?:[Zz]|[+-]\d\d:?\d\d)?$/.exec(value)?.[1] : undefined;
	return date.replace(/\.(\d{3})Z$/, (_, ms: string) => `.${(fraction ?? ms).padEnd(6, "0")}Z`);
}
/** Only identifiers discovered from the allowed table's schema enter SQL text.
 * All request values remain bound parameters. Cast legacy JSON/dates before
 * Prisma decodes them; otherwise SQLite text dates/Unsupported(json) fail. */
export class Store {
	readonly inserted: Array<{ table: Table; row: Row }> = [];
	readonly removed: Array<{ table: Table; row: Row }> = [];
	private constructor(readonly db: Database, private readonly columns: Map<Table, Column[]>) { }
	static async open(db: Database): Promise<Store> {
		const columns = new Map<Table, Column[]>();
		for (const table of tables)
			columns.set(table, await db.$queryRaw<Column[]>(Prisma.sql `PRAGMA table_info(${identifier(table)})`));
		return new Store(db, columns);
	}
	with(db: Database): Store { return new Store(db, this.columns); }
	async rows(table: Table, tail: Prisma.Sql = Prisma.empty): Promise<Row[]> {
		const columns = this.columns.get(table)!;
		const select = columns.map(c => /date|json/i.test(c.type) ? Prisma.sql `CAST(${identifier(c.name)} AS TEXT) AS ${identifier(c.name)}` : identifier(c.name));
		const rows = await this.db.$queryRaw<Row[]>(Prisma.sql `SELECT ${Prisma.join(select)} FROM ${identifier(table)} AS records ${tail}`);
		return rows.map(row => {
			for (const c of columns) {
				const value = row[c.name];
				if (value === null || value === undefined)
					continue;
				if (/json/i.test(c.type))
					row[c.name] = typeof value === "string" ? JSON.parse(value) as unknown : value;
				else if (/bool/i.test(c.type))
					row[c.name] = Boolean(value);
				else if (/date/i.test(c.type))
					row[c.name] = dateOnly[table]?.includes(c.name) ? day(sqliteDate(value as string | number | Date)) : utcTimestamp(value as string | number | Date);
				else if (typeof value === "bigint")
					row[c.name] = Number(value);
			}
			return row;
		});
	}
	async one(table: Table, id: number, label: string): Promise<Row> {
		const row = (await this.rows(table, Prisma.sql `WHERE id = ${id}`))[0];
		if (!row)
			throw new BusinessError(404, `${label} not found`);
		return row;
	}
	private values(table: Table, data: Row): Array<[
		string,
		unknown
	]> {
		const columns = this.columns.get(table)!;
		return Object.entries(data).map(([key, value]) => {
			const col = columns.find(c => c.name === key);
			if (!col || value === undefined)
				throw new Error("Invalid business persistence field");
			if (value !== null && /json/i.test(col.type))
				value = JSON.stringify(value);
			else if (value !== null && /date/i.test(col.type))
				value = dateOnly[table]?.includes(key) ? String(value).slice(0, 10) : utcTimestamp(value as string | number | Date).replace("T", " ").replace(/Z$/, "");
			return [key, value];
		});
	}
	async insert(table: Table, data: Row): Promise<Row> {
		const cols = this.columns.get(table)!;
		const now = sqliteTimestamp();
		const input = { ...(cols.some(c => c.name === "created_at") ? { created_at: now } : {}), ...(cols.some(c => c.name === "updated_at") ? { updated_at: now } : {}), ...data };
		const entries = this.values(table, input);
		await this.db.$executeRaw(Prisma.sql `INSERT INTO ${identifier(table)} (${Prisma.join(entries.map(([k]) => identifier(k)))}) VALUES (${Prisma.join(entries.map(([, v]) => v))})`);
		const [id] = await this.db.$queryRaw<Array<{
			id: bigint;
		}>> `SELECT last_insert_rowid() AS id`;
		const row = await this.one(table, Number(id.id), "Record");
		this.inserted.push({ table, row });
		return row;
	}
	async update(table: Table, id: number, data: Row): Promise<void> {
		const input = { ...data, ...(this.columns.get(table)!.some(c => c.name === "updated_at") ? { updated_at: sqliteTimestamp() } : {}) };
		const entries = this.values(table, input);
		if (!entries.length)
			return;
		await this.db.$executeRaw(Prisma.sql `UPDATE ${identifier(table)} SET ${Prisma.join(entries.map(([k, v]) => Prisma.sql `${identifier(k)} = ${v}`))} WHERE id = ${id}`);
	}
	async remove(table: Table, id: number): Promise<void> {
		if (table === "wishlist_items") this.removed.push({ table, row: await this.one(table, id, "Wishlist item") });
		await this.db.$executeRaw(Prisma.sql `DELETE FROM ${identifier(table)} WHERE id = ${id}`);
	}
}
export class BusinessError extends Error {
	constructor(readonly status: number, readonly detail: string | unknown[]) { super("Business request rejected"); }
}
// Python date.today() follows the process/host timezone, whereas stored
// datetimes remain UTC. Explicit Date arguments represent persisted dates.
export const day = (date?: Date) => date ? date.toISOString().slice(0, 10) : (() => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
})();
export const addDays = (date: string, offset: number) => day(new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000));
export const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
export const monday = (date: string) => addDays(date, -weekday(date));
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const pick = (row: Row, names: string): Row => Object.fromEntries(names.split(" ").map(k => [k, row[k] ?? null]));
export const userView = (row: Row) => pick(row, "id username display_name role points_balance total_points_earned current_streak longest_streak streak_freezes_used streak_freeze_month avatar_config is_active created_at");
export const object = (value: unknown): Row => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
/** Acquire SQLite's writer reservation before reading mutable balances/state.
 * A rejected operation/constraint/notification failure rolls back all writes.
 * No network deliveries run inside this transaction. */
export async function write<T>(prisma: PrismaClient, store: Store, operation: (tx: Store) => Promise<T>): Promise<T> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw `UPDATE users SET id = id WHERE 0`;
		return operation(store.with(tx));
	}, { maxWait: 10000, timeout: 20000 });
}
