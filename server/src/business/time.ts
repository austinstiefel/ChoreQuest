import { sqliteDate } from "../db/legacySqlite.js";
import type { Row } from "./store.js";

/** Compare UTC instants at Python datetime's microsecond resolution. Date.parse
 * alone truncates the final three digits and can activate/expire an event early.
 * Accept both the legacy SQLite naive UTC and normalized ISO representations. */
function microseconds(value: string | Date): bigint {
	const millis = sqliteDate(value).getTime();
	const fraction = typeof value === "string" ? /\.(\d{1,6})(?:[Zz]|[+-]\d\d:?\d\d)?$/.exec(value)?.[1] : undefined;
	return BigInt(millis) * 1000n + BigInt(fraction?.padEnd(6, "0").slice(3) ?? "0");
}
export function compareTimestamps(a: string | Date, b: string | Date): number {
	const left = microseconds(a), right = microseconds(b);
	return left < right ? -1 : left > right ? 1 : 0;
}
export function eventInRange(event: Row, now = new Date()): boolean {
	return Boolean(event.is_active) && compareTimestamps(String(event.start_date), now) <= 0 && compareTimestamps(now, String(event.end_date)) <= 0;
}
