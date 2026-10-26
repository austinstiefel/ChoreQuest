import { createHash, randomBytes, randomInt } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Router, type Request, type Response, type NextFunction } from "express";
import { insertAccount } from "../auth/accounts.js";
import { hashPassword } from "../auth/passwords.js";
import type { AuthConfig } from "../config/auth.js";
import { createdAtOrder, sqliteDate, sqliteTimestamp } from "../db/legacySqlite.js";
import { NULLABLE_USER_REFERENCES, requireDeletionSchema } from "../db/accountSchema.js";
import { createAuthenticateRequest, requireAdmin } from "../middleware/auth.js";
import { accountBody, toAuthUserRecord, userResponse, type AuthRepository, type RawUserRecord } from "./auth.js";

const ROLES = ["admin", "parent", "kid"];
class AdminError extends Error {
	constructor(readonly status: number, readonly detail: string) { super(detail); }
}

function uniqueConflict(error: unknown): boolean {
	return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002"
		|| (error.code === "P2010" && ["2067", "1555"].includes(String(error.meta?.code))));
}

async function account(tx: Prisma.TransactionClient, id: number) {
	const rows = await tx.$queryRaw<RawUserRecord[]>`
    SELECT id, username, display_name, password_hash, pin_hash, role,
      points_balance, total_points_earned, current_streak, longest_streak,
      streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
    FROM users WHERE id = ${id}
  `;
	if (rows[0] === undefined) throw new AdminError(404, "User not found");
	return toAuthUserRecord(rows[0]);
}

export function createPrismaAdminRepository(prisma: PrismaClient) {
	return {
		async listUsers() {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
        FROM users ORDER BY id
      `;
			return rows.map(toAuthUserRecord);
		},
		async createUser(input: { username: string; displayName: string; passwordHash: string; role: string }) {
			try {
				return await prisma.$transaction(async (tx) => {
					await tx.$executeRaw`UPDATE users SET id = id WHERE 0`;
					return account(tx, await insertAccount(tx, input));
				});
			} catch (error) {
				if (uniqueConflict(error)) throw new AdminError(409, "Username already taken");
				throw error;
			}
		},
		async updateUser(id: number, change: { role?: string; isActive?: boolean }) {
			return prisma.$transaction(async (tx) => {
				// Serialize last-admin decisions with deletion and other role changes.
				await tx.$executeRaw`UPDATE users SET id = id WHERE 0`;
				const user = await account(tx, id);
				if (user.role === "admin" && await tx.users.count({ where: { role: "admin" } }) <= 1) {
					if (change.role !== undefined && change.role !== "admin") throw new AdminError(400, "Cannot change the role of the only administrator");
					if (change.isActive === false) throw new AdminError(400, "Cannot deactivate the only administrator");
				}
				await tx.$executeRaw`UPDATE users SET role = COALESCE(${change.role ?? null}, role),
          is_active = COALESCE(${change.isActive ?? null}, is_active), updated_at = ${sqliteTimestamp()} WHERE id = ${id}`;
				return account(tx, id);
			});
		},
		async deleteUser(id: number, adminId: number) {
			await prisma.$transaction(async (tx) => {
				await tx.$executeRaw`UPDATE users SET id = id WHERE 0`;
				const user = await account(tx, id);
				if (id === adminId) throw new AdminError(400, "Administrators cannot delete their own account");
				if (user.role === "admin" && await tx.users.count({ where: { role: "admin" } }) <= 1) {
					throw new AdminError(400, "Cannot delete the final administrator");
				}
				await requireDeletionSchema(tx);
				// These fixed lists mirror Python's explicit ownership policy. SQL
				// identifiers come only from this source code, never request input.
				for (const [table, column] of NULLABLE_USER_REFERENCES) {
					await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(table)} SET ${Prisma.raw(column)} = NULL WHERE ${Prisma.raw(column)} = ${id}`);
				}
				const rotations = await tx.$queryRaw<Array<{ id: number; kid_ids: string }>>`SELECT id, CAST(kid_ids AS TEXT) AS kid_ids FROM chore_rotations`;
				for (const rotation of rotations) {
					const ids: unknown = JSON.parse(rotation.kid_ids);
					if (Array.isArray(ids) && ids.includes(id)) await tx.$executeRaw`
            UPDATE chore_rotations SET kid_ids = ${JSON.stringify(ids.filter((kidId) => kidId !== id))} WHERE id = ${rotation.id}
          `;
				}
				for (const table of ["refresh_tokens", "chore_assignments", "chore_exclusions", "chore_assignment_rules",
					"reward_redemptions", "point_transactions", "user_achievements", "wishlist_items", "notifications",
					"spin_results", "push_subscriptions", "user_avatar_items"]) {
					await tx.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE user_id = ${id}`);
				}
				await tx.users.delete({ where: { id }, select: { id: true } });
			});
		},
		async resetPassword(id: number, passwordHash: string) {
			return prisma.$transaction(async (tx) => {
				const user = await account(tx, id);
				await tx.$executeRaw`UPDATE users SET password_hash = ${passwordHash}, updated_at = ${sqliteTimestamp()} WHERE id = ${id}`;
				// Python does not revoke refresh sessions or record an admin reset audit.
				return user.username;
			});
		},
		async listApiKeys() {
			const rows = await prisma.$queryRaw<Array<{
				id: number; name: string; key_prefix: string; scopes: string;
				last_used_at: string | null; is_active: boolean; created_at: string;
			}>>(Prisma.sql`SELECT id, name, key_prefix, CAST(scopes AS TEXT) AS scopes,
        CAST(last_used_at AS TEXT) AS last_used_at, is_active, CAST(created_at AS TEXT) AS created_at
        FROM api_keys AS records ORDER BY ${createdAtOrder} DESC`);
			return rows.map((row) => ({ ...row, scopes: JSON.parse(row.scopes) as unknown[],
				created_at: sqliteDate(row.created_at), last_used_at: row.last_used_at === null ? null : sqliteDate(row.last_used_at) }));
		},
		async createApiKey(name: string, scopes: string[], adminId: number) {
			const key = randomBytes(32).toString("hex");
			return prisma.$transaction(async (tx) => {
				const now = new Date();
				await tx.$executeRaw`
          INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_by, last_used_at, is_active, created_at)
          VALUES (${name}, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, ${JSON.stringify(scopes)}, ${adminId}, NULL, ${true}, ${sqliteTimestamp(now)})
        `;
				const [row] = await tx.$queryRaw<Array<{ id: number }>>`SELECT last_insert_rowid() AS id`;
				return { id: Number(row.id), name, key, key_prefix: key.slice(0, 8), scopes, created_at: now };
			});
		},
		async revokeApiKey(id: number) {
			if ((await prisma.api_keys.updateMany({ where: { id }, data: { is_active: false } })).count !== 1) throw new AdminError(404, "API key not found");
		},
		async listInviteCodes() {
			const rows = await prisma.$queryRaw<Array<{ id: number; code: string; role: string; max_uses: number;
				times_used: number; expires_at: string | null; created_at: string;
			}>>(Prisma.sql`SELECT id, code, role, max_uses, times_used,
        CAST(expires_at AS TEXT) AS expires_at, CAST(created_at AS TEXT) AS created_at
        FROM invite_codes AS records ORDER BY ${createdAtOrder} DESC`);
			return rows.map((row) => ({ ...row, created_at: sqliteDate(row.created_at),
				expires_at: row.expires_at === null ? null : sqliteDate(row.expires_at) }));
		},
		async createInviteCode(input: { role: string; maxUses: number; expiresAt: Date | null; adminId: number }) {
			const alphabet = "ACDEFGHJKMNPQRTUVWXY34679";
			for (;;) {
				const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
				try {
					return await prisma.$transaction(async (tx) => {
						const now = new Date();
						await tx.$executeRaw`INSERT INTO invite_codes (code, role, max_uses, times_used, expires_at, created_by, created_at)
              VALUES (${code}, ${input.role}, ${input.maxUses}, 0,
                ${input.expiresAt === null ? null : sqliteTimestamp(input.expiresAt)}, ${input.adminId}, ${sqliteTimestamp(now)})`;
						const [row] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT last_insert_rowid() AS id`;
						return { id: Number(row.id), code, role: input.role, max_uses: input.maxUses, times_used: 0,
							expires_at: input.expiresAt, created_at: now };
					});
				} catch (error) { if (!uniqueConflict(error)) throw error; }
			}
		},
		async deleteInviteCode(id: number) {
			if ((await prisma.invite_codes.deleteMany({ where: { id } })).count !== 1) throw new AdminError(404, "Invite code not found");
		},
		async auditLog(input: { limit: number; offset: number; action?: string; userId?: number }) {
			const rows = await prisma.$queryRaw<Array<{
				id: number; user_id: number | null; action: string; details: string | null; ip_address: string | null; created_at: string;
			}>>(Prisma.sql`SELECT id, user_id, action, CAST(details AS TEXT) AS details, ip_address, CAST(created_at AS TEXT) AS created_at FROM audit_logs AS records
        WHERE (${input.action || null} IS NULL OR action = ${input.action || null})
          AND (${input.userId ?? null} IS NULL OR user_id = ${input.userId ?? null})
        ORDER BY ${createdAtOrder} DESC LIMIT ${input.limit} OFFSET ${input.offset}`);
			return rows.map((row) => ({ ...row, created_at: sqliteDate(row.created_at), details: row.details === null ? null : JSON.parse(row.details) as unknown }));
		},
	};
}

export type AdminRepository = ReturnType<typeof createPrismaAdminRepository>;

function pathId(request: Request, response: Response): number | null {
	const value = request.params.id;
	const parameter = request.path.startsWith("/api-keys/") ? "key_id" : request.path.startsWith("/invite-codes/") ? "code_id" : "user_id";
	if (typeof value !== "string" || !/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
		response.status(422).json({ detail: [{ type: "int_parsing", loc: ["path", parameter], msg: "Input should be a valid integer, unable to parse string as an integer" }] });
		return null;
	}
	return Number(value);
}

export function createAdminRouter(input: { config: AuthConfig; auth: AuthRepository; repository: AdminRepository }): Router {
	const router = Router();
	router.use(createAuthenticateRequest(input.config, input.auth), requireAdmin);
	const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
		try { await fn(req, res); } catch (error) {
			if (error instanceof AdminError) res.status(error.status).json({ detail: error.detail });
			else next(error);
		}
	};
	router.get("/users", handle(async (_req, res) => { res.json((await input.repository.listUsers()).map(userResponse)); }));
	router.post("/users", handle(async (req, res) => {
		const body = accountBody(req.body, res, {
			username: { type: "string", minLength: 2, maxLength: 50 },
			password: { type: "string", minLength: 6 }, display_name: { type: "string", minLength: 1, maxLength: 30 },
			role: { type: "string", choices: ROLES, defaultValue: "kid" },
		});
		if (body === null) return;
		res.json(userResponse(await input.repository.createUser({
			username: body.username as string, displayName: body.display_name as string,
			passwordHash: await hashPassword(body.password as string), role: body.role as string,
		})));
	}));
	router.put("/users/:id", handle(async (req, res) => {
		const id = pathId(req, res); if (id === null) return;
		const body = accountBody(req.body, res, {
			role: { type: "string", optional: true, nullable: true, choices: ROLES },
			is_active: { type: "bool", optional: true, nullable: true },
		});
		if (body === null) return;
		res.json(userResponse(await input.repository.updateUser(id, {
			role: (body.role ?? undefined) as string | undefined, isActive: (body.is_active ?? undefined) as boolean | undefined,
		})));
	}));
	router.delete("/users/:id", handle(async (req, res) => {
		const id = pathId(req, res); if (id === null) return;
		await input.repository.deleteUser(id, req.authenticatedUser!.id);
		res.json({ detail: "User permanently deleted" });
	}));
	router.post("/users/:id/reset-password", handle(async (req, res) => {
		const id = pathId(req, res); if (id === null) return;
		const body = accountBody(req.body, res, { new_password: { type: "string", minLength: 6 } });
		if (body === null) return;
		const username = await input.repository.resetPassword(id, await hashPassword(body.new_password as string));
		res.json({ detail: `Password reset for ${username}` });
	}));
	router.get("/api-keys", handle(async (_req, res) => { res.json(await input.repository.listApiKeys()); }));
	router.post("/api-keys", handle(async (req, res) => {
		const body = accountBody(req.body, res, { name: { type: "string", maxLength: 100 }, scopes: { type: "strings", defaultValue: [] } });
		if (body !== null) res.json(await input.repository.createApiKey(body.name as string, body.scopes as string[], req.authenticatedUser!.id));
	}));
	router.delete("/api-keys/:id", handle(async (req, res) => {
		const id = pathId(req, res); if (id === null) return;
		await input.repository.revokeApiKey(id); res.json({ detail: "API key revoked" });
	}));
	router.get("/invite-codes", handle(async (_req, res) => { res.json(await input.repository.listInviteCodes()); }));
	router.post("/invite-codes", handle(async (req, res) => {
		const body = accountBody(req.body, res, {
			role: { type: "string", choices: ROLES }, max_uses: { type: "int", defaultValue: 1 },
			expires_at: { type: "datetime", optional: true, nullable: true },
		});
		if (body !== null) res.json(await input.repository.createInviteCode({
			role: body.role as string, maxUses: body.max_uses as number,
			expiresAt: (body.expires_at ?? null) as Date | null, adminId: req.authenticatedUser!.id,
		}));
	}));
	router.delete("/invite-codes/:id", handle(async (req, res) => {
		const id = pathId(req, res); if (id === null) return;
		await input.repository.deleteInviteCode(id); res.json({ detail: "Invite code deleted" });
	}));
	router.get("/audit-log", handle(async (req, res) => {
		const { limit = "50", offset = "0", action, user_id } = req.query;
		const integer = (value: unknown) => typeof value === "string" && /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
		const errors: Array<{ type: string; loc: string[]; msg: string; ctx?: Record<string, number> }> = [];
		for (const [field, value, min, max] of [["limit", limit, 1, 200], ["offset", offset, 0, undefined], ["user_id", user_id, undefined, undefined]] as const) {
			if (value === undefined) continue;
			const loc = ["query", field];
			if (!integer(value)) errors.push({ type: "int_parsing", loc, msg: "Input should be a valid integer, unable to parse string as an integer" });
			else if (min !== undefined && Number(value) < min) errors.push({ type: "greater_than_equal", loc, msg: `Input should be greater than or equal to ${min}`, ctx: { ge: min } });
			else if (max !== undefined && Number(value) > max) errors.push({ type: "less_than_equal", loc, msg: `Input should be less than or equal to ${max}`, ctx: { le: max } });
		}
		if (action !== undefined && typeof action !== "string") errors.push({ type: "string_type", loc: ["query", "action"], msg: "Input should be a valid string" });
		if (errors.length > 0) {
			res.status(422).json({ detail: errors }); return;
		}
		res.json(await input.repository.auditLog({ limit: Number(limit), offset: Number(offset), action: action as string | undefined,
			userId: user_id === undefined ? undefined : Number(user_id) }));
	}));
	return router;
}
