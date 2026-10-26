import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Explicit empty-file creation only; never overwrite a database or create parents. */
export async function initializeSqlite(path) {
	if (!path || !isAbsolute(path)) throw new Error("An absolute new SQLite file path is required");
	const target = resolve(path);
	if (!(await stat(dirname(target))).isDirectory()) throw new Error("Database parent must be an existing directory");
	const file = await open(target, "wx", 0o600);
	await file.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		await initializeSqlite(process.argv[2]);
		console.log("Empty SQLite file initialized; apply Prisma migrations before starting the application.");
	} catch {
		console.error("SQLite initialization refused: use a new absolute path with an existing parent; no existing file was overwritten.");
		process.exitCode = 1;
	}
}
