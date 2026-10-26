import { Prisma } from "@prisma/client";

/** SQLAlchemy's SQLite DateTime format: naive UTC, six fractional digits. */
export function sqliteTimestamp(value: Date = new Date()): string {
	if (Number.isNaN(value.getTime()) || value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) {
		throw new RangeError("Timestamp is outside Python's datetime range");
	}
	return value.toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}000`);
}

/** Read both Python's naive UTC text and Prisma's SQLite epoch milliseconds. */
export function sqliteDate(value: Date | string | number): Date {
	if (value instanceof Date) return value;
	let date: Date;
	if (typeof value === "number" || /^[+-]?\d+(?:\.\d+)?$/.test(value)) {
		date = new Date(Number(value));
	} else {
		const normalized = value.replace(" ", "T");
		date = new Date(normalized + (/T/.test(normalized) && !/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(normalized) ? "Z" : ""));
	}
	if (Number.isNaN(date.getTime())) throw new Error("Invalid stored account timestamp");
	return date;
}

/** Fixed SQL expression: sortable epoch milliseconds without rewriting data. */
export const createdAtOrder = Prisma.sql`CASE
  WHEN typeof(records.created_at) IN ('integer', 'real') THEN records.created_at
  ELSE (julianday(records.created_at) - 2440587.5) * 86400000
END`;
