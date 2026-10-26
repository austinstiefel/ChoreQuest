import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Match Prisma's schema-relative file URLs, without printing configuration. */
export function sqliteFilePath(url: string | undefined): string {
	if (!url?.startsWith("file:") || url.includes("\0")) throw new Error("Configure DATABASE_URL as a provisioned SQLite file; see server/prisma/README.md");
	const path = url.slice(5).split("?")[0];
	if (!path || path === ":memory:") throw new Error("A durable provisioned SQLite file is required");
	return resolve(fileURLToPath(new URL("../../prisma/", import.meta.url)), path);
}

/** Prevent Prisma's implicit file creation on an incorrect/uninitialized path. */
export function requireSqliteFile(url: string | undefined): string {
	let descriptor: number | undefined;
	try {
		const path = sqliteFilePath(url);
		descriptor = openSync(path, "r");
		if (!fstatSync(descriptor).isFile()) throw new Error();
		const header = Buffer.alloc(16);
		if (readSync(descriptor, header, 0, 16, 0) !== 16 || header.toString("ascii") !== "SQLite format 3\0") throw new Error();
		return path;
	} catch {
		throw new Error("SQLite database is missing, invalid or uninitialized; initialize/apply migrations explicitly. See server/prisma/README.md");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
