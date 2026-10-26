import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { initializeSqlite } from "./initialize-sqlite.mjs";

// Diagnostic only: both Prisma commands receive separate, new temporary files.
// Run from server with: pnpm exec node scripts/verify-schema-engine.mjs
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("prisma/package.json")), "build/index.js");
const directory = await mkdtemp(join(tmpdir(), "chorequest-schema-engine-"));
let failed = false;
try {
	const schemaDirectory = join(directory, "prisma");
	await mkdir(schemaDirectory);
	await cp(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), join(schemaDirectory, "schema.prisma"));
	await cp(fileURLToPath(new URL("../prisma/migrations", import.meta.url)), join(schemaDirectory, "migrations"), { recursive: true });
	for (const [name, args] of [
		["db push", ["db", "push", "--skip-generate"]],
		["migrate deploy", ["migrate", "deploy"]],
	]) {
		const databasePath = join(directory, name.replaceAll(" ", "-") + ".db");
		// Explicit initialization also works where CLI missing-file auto-creation
		// fails in an agent/pipe context; it never overwrites an existing file.
		await initializeSqlite(databasePath);
		const url = `file:${databasePath.replaceAll("\\", "/")}`;
		let prisma;
		try {
			const output = execFileSync(process.execPath, [cli, ...args, "--schema", join(schemaDirectory, "schema.prisma")], {
				cwd: directory,
				env: { ...process.env, DATABASE_URL: url },
				encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: "pipe",
			});
			prisma = new PrismaClient({ datasources: { db: { url } } });
			const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'`;
			const integrity = await prisma.$queryRaw`PRAGMA foreign_key_check`;
			if (tables.length !== 28 || integrity.length !== 0) throw new Error("Unexpected schema or FK integrity result");
			console.log(`${name}: PASS (28 application tables; foreign_key_check clean)`);
			console.log(output.trim());
		} catch (error) {
			failed = true;
			console.error(`${name}: FAIL`);
			console.error(`exit=${error.status ?? "none"}; signal=${error.signal ?? "none"}`);
			if (error.stdout) console.error(String(error.stdout));
			console.error(String(error.stderr || error.message));
		} finally { await prisma?.$disconnect(); }
	}
	// A failing minimal schema distinguishes engine/runtime problems from
	// unsupported application columns without changing the repository schema.
	if (failed) {
		const minimalSchema = join(directory, "minimal.prisma");
		await writeFile(minimalSchema, `datasource db {
  provider = "sqlite"
  url = env("DATABASE_URL")
}
model Probe {
  id Int @id @default(autoincrement())
}
`);
		try {
			const output = execFileSync(process.execPath, [cli, "db", "push", "--skip-generate", "--schema", minimalSchema], {
				cwd: directory, env: { ...process.env, DATABASE_URL: `file:${join(directory, "minimal.db").replaceAll("\\", "/")}` },
				encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: "pipe",
			});
			console.log("minimal db push: PASS"); console.log(output.trim());
		} catch (error) {
			console.error(`minimal db push: FAIL (exit=${error.status ?? "none"}; signal=${error.signal ?? "none"})`);
			if (error.stdout) console.error(String(error.stdout));
			console.error(String(error.stderr || error.message));
		}
		try {
			const output = execFileSync(process.execPath, [cli, "db", "push", "--skip-generate", "--schema", minimalSchema], {
				cwd: directory, env: { ...process.env, DATABASE_URL: "file:./relative-probe.db" },
				encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: "pipe",
			});
			console.log("minimal relative-URL db push: PASS"); console.log(output.trim());
		} catch (error) {
			console.error("minimal relative-URL db push: FAIL");
			console.error(String(error.stderr || error.message));
		}
	}
} finally {
	try { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	catch (error) { console.error(`Temporary diagnostic directory remains locked: ${directory} (${error.code})`); }
}
if (failed) process.exitCode = 1;
