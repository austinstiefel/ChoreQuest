import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

/** Provision only a new temporary database from the checked-in baseline SQL. */
export async function disposableDatabase(legacy = false) {
	const directory = await mkdtemp(resolve(tmpdir(), "chorequest-auth-"));
	const databasePath = resolve(directory, "test.db");
	const prisma = new PrismaClient({ datasources: { db: {
		url: `file:${databasePath.replaceAll("\\", "/")}?connection_limit=1`,
	} } });
	let sql = await readFile(fileURLToPath(new URL("../../prisma/migrations/00000000000000_baseline/migration.sql", import.meta.url)), "utf8");
	if (legacy) {
		const definitions = await readFile(fileURLToPath(new URL("../fixtures/legacy-account-tables.sql", import.meta.url)), "utf8");
		const tables = new Map([...definitions.matchAll(/CREATE TABLE (\w+) \([\s\S]*?\n\);/g)].map((match) => [match[1], match[0]]));
		sql = sql.replace(/CREATE TABLE "(\w+)" \([\s\S]*?\n\);/g, (definition, name: string) => tables.get(name) ?? definition);
	}
	try {
		for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
			await prisma.$executeRawUnsafe(statement);
		}
		await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
	} catch (error) {
		await prisma.$disconnect();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return { prisma, directory, databasePath, async dispose() {
		await prisma.$disconnect();
		await rm(directory, { recursive: true, force: true });
	} };
}
