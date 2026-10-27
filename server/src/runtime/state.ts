import { Prisma } from "@prisma/client";
import type { Database } from "../business/store.js";
import { sqliteTimestamp } from "../db/legacySqlite.js";
// Existing app_settings already stores internal authentication/VAPID state.
// Reserve a namespace for small runtime checkpoints and delivery jobs. No table
// rebuild or migration is necessary; these keys must never be parent-editable.
export const RUNTIME_PREFIX = "__runtime_";
export async function putState(db: Database, key: string, value: unknown): Promise<void> {
	await db.$executeRaw `INSERT INTO app_settings (key,value,updated_at) VALUES (${key},${JSON.stringify(value)},${sqliteTimestamp()}) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;
}
export async function getState<T>(db: Database, key: string): Promise<T | null> {
	const rows = await db.$queryRaw<Array<{
		value: string;
	}>> `SELECT value FROM app_settings WHERE key=${key}`;
	return rows.length ? JSON.parse(rows[0].value) as T : null;
}
export async function deleteState(db: Database, key: string): Promise<void> {
	await db.$executeRaw `DELETE FROM app_settings WHERE key=${key}`;
}
export const pushJobPrefix = `${RUNTIME_PREFIX}push.`;
// GLOB treats underscores literally; SQL LIKE would let parent-created
// lookalike keys match the private namespace because '_' is a wildcard.
export const pushJobsFilter = Prisma.sql `key GLOB ${pushJobPrefix + "*"}`;
