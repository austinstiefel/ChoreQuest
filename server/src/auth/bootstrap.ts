import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { insertAccount } from "./accounts.js";
import { hashPassword } from "./passwords.js";
import { sqliteTimestamp } from "../db/legacySqlite.js";

export interface BootstrapConfig {
	username: string;
	displayName: string;
	password: string;
}

export function loadBootstrapConfig(environment: Readonly<Record<string, string | undefined>> = process.env): BootstrapConfig {
	return {
		username: environment.INITIAL_ADMIN_USERNAME?.trim() || "Admin",
		displayName: environment.INITIAL_ADMIN_DISPLAY_NAME?.trim() || "Administrator",
		password: environment.INITIAL_ADMIN_PASSWORD ?? "",
	};
}

/** Any existing user prevents bootstrap, exactly as in backend/bootstrap.py. */
export async function bootstrapInitialAdmin(prisma: PrismaClient, config: BootstrapConfig): Promise<boolean> {
	if (await prisma.users.count() > 0) return false;
	if ([...config.username].length < 2 || [...config.username].length > 50) {
		throw new Error("INITIAL_ADMIN_USERNAME must be between 2 and 50 characters.");
	}
	if ([...config.displayName].length < 1 || [...config.displayName].length > 30) {
		throw new Error("INITIAL_ADMIN_DISPLAY_NAME must be between 1 and 30 characters.");
	}
	if (config.password && [...config.password].length < 6) {
		throw new Error("INITIAL_ADMIN_PASSWORD must be at least 6 characters.");
	}
	const passwordHash = await hashPassword(config.password || randomBytes(32).toString("base64url"));
	return prisma.$transaction(async (tx) => {
		// Acquire SQLite's writer lock before checking emptiness again. Concurrent
		// processes cannot both decide to bootstrap; no existing row is changed.
		await tx.$executeRaw`UPDATE users SET id = id WHERE 0`;
		if (await tx.users.count() > 0) return false;
		await insertAccount(tx, {
			username: config.username, displayName: config.displayName, passwordHash, role: "admin",
		});
		const now = sqliteTimestamp();
		for (const [key, value] of [
			["initial_setup_complete", "false"],
			["initial_password_setup_required", config.password ? "false" : "true"],
		]) {
			await tx.$executeRaw`INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, ${now})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
		}
		return true;
	});
}
