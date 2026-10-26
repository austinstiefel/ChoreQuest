import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { hashPassword, hashPin, verifyPassword, verifyPin } from "../auth/passwords.js";
import {
	createAccessToken,
	createRefreshToken,
	decodeRefreshToken,
} from "../auth/tokens.js";
import type { AuthConfig } from "../config/auth.js";
import { sqliteDate, sqliteTimestamp } from "../db/legacySqlite.js";
import {
	createAuthenticateRequest,
	createPrismaAuthUserRepository,
	type AuthUserRepository,
} from "../middleware/auth.js";

const REFRESH_COOKIE_NAME = "refresh_token";
const SETUP_COMPLETE_KEY = "initial_setup_complete";
const INITIAL_PASSWORD_SETUP_REQUIRED_KEY = "initial_password_setup_required";

export interface AuthUserRecord {
	id: number;
	username: string;
	display_name: string;
	password_hash: string;
	pin_hash: string | null;
	role: string;
	points_balance: number;
	total_points_earned: number;
	current_streak: number;
	longest_streak: number;
	streak_freezes_used: number;
	streak_freeze_month: number | null;
	avatar_config: unknown | null;
	is_active: boolean;
	created_at: Date;
}

export interface RefreshTokenRecord {
	id: number;
	user_id: number;
	is_revoked: boolean;
}

export interface AuthRepository extends AuthUserRepository {
	findFirstActiveAdmin(): Promise<AuthUserRecord | null>;
	findActiveAdmins(): Promise<AuthUserRecord[]>;
	findSetting(key: string): Promise<string | null>;
	findUserByUsername(username: string): Promise<AuthUserRecord | null>;
	completeInitialPasswordSetup(input: {
		userId: number;
		passwordHash: string;
		ipAddress: string | null;
	}): Promise<boolean>;
	recordPasswordLogin(input: {
		userId: number;
		isAdmin: boolean;
		ipAddress: string | null;
	}): Promise<void>;
	recordPinLogin(input: { userId: number; ipAddress: string | null }): Promise<void>;
	storeRefreshToken(input: {
		userId: number;
		tokenHash: string;
		expiresAt: Date;
		expectedPasswordHash?: string;
		expectedPinHash?: string;
	}): Promise<void>;
	findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
	findActiveUserById(userId: number): Promise<AuthUserRecord | null>;
	rotateRefreshToken(input: {
		tokenHash: string;
		userId: number;
		replacementTokenHash: string;
		replacementExpiresAt: Date;
	}): Promise<"rotated" | "not_found" | "revoked">;
	revokeRefreshTokenByHash(tokenHash: string): Promise<void>;
	updateProfile(input: {
		userId: number;
		displayName?: string;
		avatarConfig?: Record<string, unknown>;
	}): Promise<void>;
	changePassword(input: {
		userId: number;
		expectedPasswordHash: string;
		passwordHash: string;
		ipAddress: string | null;
	}): Promise<boolean>;
	setPin(input: { userId: number; pinHash: string }): Promise<void>;
}

export interface AuthRateLimiter {
	/** Return the number of seconds to retry after, or undefined when allowed. */
	check(key: string, maxRequests: number, windowSeconds: number): number | undefined;
}

/** Mirrors the Python process-local sliding-window limits used by auth routes. */
export class SlidingWindowRateLimiter implements AuthRateLimiter {
	private readonly windows = new Map<string, number[]>();

	constructor(private readonly now: () => number = () => Date.now() / 1000) {}

	check(key: string, maxRequests: number, windowSeconds: number): number | undefined {
		const now = this.now();
		const cutoff = now - windowSeconds;
		const timestamps = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

		if (timestamps.length >= maxRequests) {
			this.windows.set(key, timestamps);
			return Math.floor(timestamps[0] + windowSeconds - now) + 1;
		}

		timestamps.push(now);
		this.windows.set(key, timestamps);
		return undefined;
	}
}

export type RawUserRecord = Omit<AuthUserRecord, "avatar_config" | "created_at"> & {
	avatar_config: unknown | null;
	created_at: Date | string | number;
};

class InitialSetupUnavailableError extends Error {}
export class StaleCredentialsError extends Error {}

function parseAvatarConfig(value: unknown): unknown | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return JSON.parse(value) as unknown;
	return value;
}

export function toAuthUserRecord(user: RawUserRecord): AuthUserRecord {
	return {
		...user,
		avatar_config: parseAvatarConfig(user.avatar_config),
		created_at: sqliteDate(user.created_at),
	};
}

/**
 * Build the persistence adapter for the existing SQLite schema. Prisma marks
 * the legacy JSON columns as Unsupported, so user reads and audit JSON writes
 * use parameterized SQL. Timestamp writes also use SQLAlchemy-compatible UTC
 * text, rather than Prisma's epoch milliseconds. Typed reads select no dates.
 */
export function createPrismaAuthRepository(prisma: PrismaClient): AuthRepository {
	return {
		...createPrismaAuthUserRepository(prisma),
		async findFirstActiveAdmin() {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
        FROM users
        WHERE role = ${"admin"} AND is_active = ${true}
        ORDER BY id
        LIMIT 1
      `;
			return rows[0] === undefined ? null : toAuthUserRecord(rows[0]);
		},

		async findActiveAdmins() {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
        FROM users
        WHERE role = ${"admin"} AND is_active = ${true}
        ORDER BY id
      `;
			return rows.map(toAuthUserRecord);
		},

		async findSetting(key) {
			const setting = await prisma.app_settings.findUnique({
				where: { key },
				select: { value: true },
			});
			return setting?.value ?? null;
		},

		async findUserByUsername(username) {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
        FROM users
        WHERE username = ${username}
        LIMIT 1
      `;
			return rows[0] === undefined ? null : toAuthUserRecord(rows[0]);
		},

		async completeInitialPasswordSetup(input) {
			try {
				return await prisma.$transaction(async (tx) => {
					const now = sqliteTimestamp();
					const transition = await tx.$executeRaw`UPDATE app_settings SET value = 'true', updated_at = ${now}
            WHERE key = ${SETUP_COMPLETE_KEY} AND value = 'false'`;
					if (transition !== 1) throw new InitialSetupUnavailableError();
					const admins = await tx.users.findMany({ where: { role: "admin", is_active: true }, select: { id: true } });
					if (admins.length !== 1 || admins[0].id !== input.userId) throw new InitialSetupUnavailableError();

					const passwordSetup = await tx.$executeRaw`UPDATE app_settings SET value = 'false', updated_at = ${now}
            WHERE key = ${INITIAL_PASSWORD_SETUP_REQUIRED_KEY} AND value = 'true'`;
					if (passwordSetup !== 1) throw new InitialSetupUnavailableError();

					await tx.$executeRaw`UPDATE users SET password_hash = ${input.passwordHash}, updated_at = ${now} WHERE id = ${input.userId}`;
					await tx.$executeRaw`
            INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
            VALUES (${input.userId}, ${"initial_password_setup"}, ${"{}"}, ${input.ipAddress}, ${now})
          `;
					return true;
				});
			} catch (error) {
				if (error instanceof InitialSetupUnavailableError) return false;
				throw error;
			}
		},

		async recordPasswordLogin(input) {
			await prisma.$transaction(async (tx) => {
				const now = sqliteTimestamp();
				await tx.$executeRaw`
          INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
          VALUES (${input.userId}, ${"login"}, ${'{"method":"password"}'}, ${input.ipAddress}, ${now})
        `;
				if (input.isAdmin) {
					await tx.$executeRaw`UPDATE app_settings SET value = 'true', updated_at = ${now}
            WHERE key = ${SETUP_COMPLETE_KEY} AND value = 'false'`;
				}
			});
		},

		async recordPinLogin(input) {
			const now = sqliteTimestamp();
			await prisma.$executeRaw`
        INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
        VALUES (${input.userId}, ${"login"}, ${'{"method":"pin"}'}, ${input.ipAddress}, ${now})
      `;
		},

		async storeRefreshToken(input) {
			await prisma.$transaction(async (tx) => {
				await tx.$executeRaw`UPDATE users SET id = id WHERE 0`;
				const current = await tx.users.findFirst({ where: {
					id: input.userId, is_active: true, password_hash: input.expectedPasswordHash, pin_hash: input.expectedPinHash,
				}, select: { id: true } });
				if (current === null) throw new StaleCredentialsError();
				await tx.$executeRaw`INSERT INTO refresh_tokens (user_id, token_hash, is_revoked, expires_at, created_at)
          VALUES (${input.userId}, ${input.tokenHash}, 0, ${sqliteTimestamp(input.expiresAt)}, ${sqliteTimestamp()})`;
			});
		},

		async findRefreshTokenByHash(tokenHash) {
			return prisma.refresh_tokens.findFirst({
				where: { token_hash: tokenHash },
				select: { id: true, user_id: true, is_revoked: true },
			});
		},

		async findActiveUserById(userId) {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, CAST(avatar_config AS TEXT) AS avatar_config, is_active, CAST(created_at AS TEXT) AS created_at
        FROM users
        WHERE id = ${userId} AND is_active = ${true}
        LIMIT 1
      `;
			return rows[0] === undefined ? null : toAuthUserRecord(rows[0]);
		},

		async rotateRefreshToken(input) {
			return prisma.$transaction(async (tx) => {
				const revoked = await tx.refresh_tokens.updateMany({
					where: {
						token_hash: input.tokenHash,
						user_id: input.userId,
						is_revoked: false,
					},
					data: { is_revoked: true },
				});
				if (revoked.count === 1) {
					await tx.$executeRaw`INSERT INTO refresh_tokens (user_id, token_hash, is_revoked, expires_at, created_at)
            VALUES (${input.userId}, ${input.replacementTokenHash}, 0,
              ${sqliteTimestamp(input.replacementExpiresAt)}, ${sqliteTimestamp()})`;
					return "rotated";
				}

				const existing = await tx.refresh_tokens.findFirst({
					where: { token_hash: input.tokenHash },
					select: { is_revoked: true },
				});
				return existing === null ? "not_found" : "revoked";
			});
		},

		async revokeRefreshTokenByHash(tokenHash) {
			await prisma.refresh_tokens.updateMany({
				where: { token_hash: tokenHash, is_revoked: false },
				data: { is_revoked: true },
			});
		},

		async updateProfile(input) {
			// Null and omitted values both preserve existing fields, as in Python.
			// A single parameterized statement also handles the legacy JSON column.
			await prisma.$executeRaw`
        UPDATE users
        SET display_name = COALESCE(${input.displayName ?? null}, display_name),
          avatar_config = CASE WHEN ${input.avatarConfig !== undefined}
            THEN ${input.avatarConfig === undefined ? null : JSON.stringify(input.avatarConfig)}
            ELSE avatar_config END,
          updated_at = ${sqliteTimestamp()}
        WHERE id = ${input.userId}
      `;
		},

		async changePassword(input) {
			return prisma.$transaction(async (tx) => {
				const now = sqliteTimestamp();
				const changed = await tx.$executeRaw`UPDATE users SET password_hash = ${input.passwordHash}, updated_at = ${now}
          WHERE id = ${input.userId} AND password_hash = ${input.expectedPasswordHash} AND is_active = 1`;
				if (changed !== 1) return false;
				await tx.refresh_tokens.updateMany({
					where: { user_id: input.userId, is_revoked: false },
					data: { is_revoked: true },
				});
				await tx.$executeRaw`
          INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
          VALUES (${input.userId}, ${"password_change"}, ${"{}"}, ${input.ipAddress}, ${now})
        `;
				return true;
			});
		},

		async setPin(input) {
			await prisma.$executeRaw`UPDATE users SET pin_hash = ${input.pinHash}, updated_at = ${sqliteTimestamp()} WHERE id = ${input.userId}`;
		},
	};
}

function clientAddress(request: Request): string | null {
	return request.ip || null;
}

function sendRateLimited(response: Response, retryAfter: number | undefined): boolean {
	if (retryAfter === undefined) return false;
	response.set("Retry-After", String(retryAfter)).status(429).json({ detail: "Too many requests" });
	return true;
}

export interface AccountFieldRule {
	type: "string" | "dict" | "bool" | "int" | "datetime" | "strings";
	optional?: boolean;
	nullable?: boolean;
	defaultValue?: unknown;
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
	choices?: string[];
}

function accountDateTime(value: unknown): Date | null {
	const pythonDate = (date: Date) => Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999 ? null : date;
	if (typeof value === "number" || (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value))) {
		const timestamp = Number(value);
		const date = new Date(timestamp * (Math.abs(timestamp) <= 20_000_000_000 ? 1000 : 1));
		return pythonDate(date);
	}
	if (typeof value !== "string") return null;
	const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt _](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.exec(value);
	if (parts === null) return null;
	const [year, month, day] = parts.slice(1, 4).map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(parts[4] ?? 0) > 23 || Number(parts[5] ?? 0) > 59 || Number(parts[6] ?? 0) > 59) return null;
	const normalized = value.replace(/[Tt _]/, "T");
	const date = new Date(normalized + (parts[4] !== undefined && parts[7] === undefined ? "Z" : ""));
	return pythonDate(date);
}

/** Pydantic-style account validation; extra fields are ignored, inputs are not echoed. */
export function accountBody(
	body: unknown,
	response: Response,
	rules: Record<string, AccountFieldRule>,
): Record<string, unknown> | null {
	if (body === undefined || body === null) {
		response.status(422).json({ detail: [{ type: "missing", loc: ["body"], msg: "Field required" }] });
		return null;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		response.status(422).json({ detail: [{
			type: "model_attributes_type",
			loc: ["body"],
			msg: "Input should be a valid dictionary or object to extract fields from",
		}] });
		return null;
	}
	const values = { ...body } as Record<string, unknown>;
	const errors: Array<{
		type: string;
		loc: Array<string | number>;
		msg: string;
		ctx?: Record<string, unknown>;
	}> = [];
	for (const [field, rule] of Object.entries(rules)) {
		const value = values[field];
		const loc = ["body", field];
		if (value === undefined && rule.defaultValue !== undefined) {
			values[field] = structuredClone(rule.defaultValue);
			continue;
		}
		if ((rule.optional && value === undefined) || (rule.nullable && value === null)) continue;
		if (value === undefined) {
			errors.push({ type: "missing", loc, msg: "Field required" });
		} else if (rule.type === "bool") {
			const text = typeof value === "string" ? value.toLowerCase() : value;
			if ([true, 1, "true", "1", "yes", "y", "on", "t"].includes(text as string)) values[field] = true;
			else if ([false, 0, "false", "0", "no", "n", "off", "f"].includes(text as string)) values[field] = false;
			else errors.push({ type: "bool_parsing", loc, msg: "Input should be a valid boolean, unable to interpret input" });
		} else if (rule.type === "int") {
			const parsed = typeof value === "boolean" ? Number(value) : typeof value === "string" && /^\s*[+-]?\d+(?:\.0+)?\s*$/.test(value) ? Number(value) : value;
			if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) errors.push({ type: "int_parsing", loc, msg: "Input should be a valid integer, unable to parse string as an integer" });
			else values[field] = parsed;
		} else if (rule.type === "datetime") {
			const date = accountDateTime(value);
			if (date === null) errors.push({ type: "datetime_from_date_parsing", loc, msg: "Input should be a valid datetime or date, invalid input" });
			else values[field] = date;
		} else if (rule.type === "strings") {
			if (!Array.isArray(value)) errors.push({ type: "list_type", loc, msg: "Input should be a valid list" });
			else value.forEach((entry, index) => {
				if (typeof entry !== "string") errors.push({ type: "string_type", loc: [...loc, index], msg: "Input should be a valid string" });
			});
		} else if (rule.type === "dict") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				errors.push({ type: "dict_type", loc, msg: "Input should be a valid dictionary" });
			}
		} else if (rule.choices !== undefined && (typeof value !== "string" || !rule.choices.includes(value))) {
			const expected = "'admin', 'parent' or 'kid'";
			errors.push({ type: "enum", loc, msg: `Input should be ${expected}`, ctx: { expected } });
		} else if (typeof value !== "string") {
			errors.push({ type: "string_type", loc, msg: "Input should be a valid string" });
		} else {
			// Python/Pydantic counts Unicode code points, rather than UTF-16 units.
			const length = [...value].length;
			if (rule.minLength !== undefined && length < rule.minLength) {
				errors.push({ type: "string_too_short", loc,
					msg: `String should have at least ${rule.minLength} characters`,
					ctx: { min_length: rule.minLength } });
			} else if (rule.maxLength !== undefined && length > rule.maxLength) {
				errors.push({ type: "string_too_long", loc,
					msg: `String should have at most ${rule.maxLength} characters`,
					ctx: { max_length: rule.maxLength } });
			} else if (rule.pattern !== undefined && !rule.pattern.test(value)) {
				errors.push({ type: "string_pattern_mismatch", loc,
					msg: "String should match pattern '^\\d{6}$'", ctx: { pattern: "^\\d{6}$" } });
			}
		}
	}
	if (errors.length > 0) {
		response.status(422).json({ detail: errors });
		return null;
	}
	return values;
}

export function userResponse(user: AuthUserRecord) {
	return {
		id: user.id,
		username: user.username,
		display_name: user.display_name,
		role: user.role,
		points_balance: user.points_balance,
		total_points_earned: user.total_points_earned,
		current_streak: user.current_streak,
		longest_streak: user.longest_streak,
		streak_freezes_used: user.streak_freezes_used,
		streak_freeze_month: user.streak_freeze_month,
		avatar_config: user.avatar_config,
		is_active: user.is_active,
		created_at: user.created_at,
	};
}

function setRefreshCookie(response: Response, refreshToken: string, config: AuthConfig): void {
	// Express's response.cookie adds an Expires attribute whenever maxAge is
	// supplied. Starlette's set_cookie call in the reference sends only
	// Max-Age, so write the small fixed cookie contract directly instead.
	const cookie = [
		`${REFRESH_COOKIE_NAME}=${refreshToken}`,
		"HttpOnly",
		`Max-Age=${config.refreshTokenExpireDays * 86_400}`,
		"Path=/api/auth",
		"SameSite=lax",
	];
	if (config.cookieSecure) cookie.push("Secure");
	response.append("Set-Cookie", cookie.join("; "));
}

function clearRefreshCookie(response: Response, config: AuthConfig): void {
	const cookie = [
		`${REFRESH_COOKIE_NAME}=\"\"`,
		"expires=Thu, 01 Jan 1970 00:00:00 GMT",
		"HttpOnly",
		"Max-Age=0",
		"Path=/api/auth",
		"SameSite=lax",
	];
	if (config.cookieSecure) cookie.push("Secure");
	response.append("Set-Cookie", cookie.join("; "));
}

function refreshTokenFromCookie(request: Request): string | null {
	const cookieHeader = request.get("Cookie");
	if (cookieHeader === undefined) return null;
	let token: string | null = null;
	for (const segment of cookieHeader.split(";")) {
		const [name, ...value] = segment.trim().split("=");
		if (name === REFRESH_COOKIE_NAME) {
			const raw = value.join("=").trim();
			// Starlette accepts quoted cookie values and uses the last duplicate.
			// JWTs contain no escaped characters, so only the quotes need removing.
			token = (raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw) || null;
		}
	}
	return token;
}

function parseTokenSubject(subject: string): number | null {
	if (!/^\d+$/.test(subject)) return null;
	const userId = Number(subject);
	return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

async function issueTokens(
	user: AuthUserRecord,
	repository: AuthRepository,
	config: AuthConfig,
	response: Response,
	credential: "password" | "pin" = "password",
): Promise<void> {
	const accessToken = await createAccessToken(user.id, user.role, config);
	const refreshToken = await createRefreshToken(user.id, config);
	const refreshPayload = await decodeRefreshToken(refreshToken, config);
	if (refreshPayload === null) throw new Error("Unable to create refresh token");

	try {
		await repository.storeRefreshToken({
			userId: user.id,
			tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
			expiresAt: new Date(refreshPayload.exp * 1000),
			expectedPasswordHash: user.password_hash,
			...(credential === "pin" && user.pin_hash !== null ? { expectedPinHash: user.pin_hash } : {}),
		});
	} catch (error) {
		if (!(error instanceof StaleCredentialsError)) throw error;
		response.status(401).json({ detail: credential === "pin" ? "Invalid username or PIN" : "Invalid username or password" });
		return;
	}

	setRefreshCookie(response, refreshToken, config);
	response.json({ access_token: accessToken, user: userResponse(user) });
}

export function createAuthRouter(input: {
	config: AuthConfig;
	repository: AuthRepository;
	rateLimiter?: AuthRateLimiter;
}): Router {
	const router = Router();
	const rateLimiter = input.rateLimiter ?? new SlidingWindowRateLimiter();
	const authenticate = createAuthenticateRequest(input.config, input.repository);

	async function currentAccount(request: Request, response: Response): Promise<AuthUserRecord | null> {
		const userId = request.authenticatedUser?.id;
		const user = userId === undefined ? null : await input.repository.findActiveUserById(userId);
		if (user === null) response.status(401).json({ detail: "User not found or inactive" });
		return user;
	}

	router.get("/setup-status", async (_request, response, next) => {
		try {
			const admin = await input.repository.findFirstActiveAdmin();
			if (admin === null) {
				response.json({
					setup_required: true,
					admin_username: null,
					password_setup_required: false,
				});
				return;
			}

			const [setupValue, passwordSetupValue] = await Promise.all([
				input.repository.findSetting(SETUP_COMPLETE_KEY),
				input.repository.findSetting(INITIAL_PASSWORD_SETUP_REQUIRED_KEY),
			]);
			const setupComplete = setupValue === "true";
			response.json({
				setup_required: !setupComplete,
				admin_username: admin.username,
				password_setup_required: !setupComplete && passwordSetupValue === "true",
			});
		} catch (error) {
			next(error);
		}
	});

	router.post("/setup-password", async (request, response, next) => {
		try {
			const body = accountBody(request.body, response, {
				password: { type: "string", minLength: 6 }, confirm_password: { type: "string", minLength: 6 },
			});
			if (body === null) return;
			const password = body.password as string;
			const confirmation = body.confirm_password as string;
			if (sendRateLimited(response, rateLimiter.check(`setup-password:${clientAddress(request)}`, 5, 900))) return;
			if (password !== confirmation) {
				response.status(400).json({ detail: "Passwords do not match" });
				return;
			}

			const [setupValue, passwordSetupValue, admins] = await Promise.all([
				input.repository.findSetting(SETUP_COMPLETE_KEY),
				input.repository.findSetting(INITIAL_PASSWORD_SETUP_REQUIRED_KEY),
				input.repository.findActiveAdmins(),
			]);
			if (setupValue !== "false" || passwordSetupValue !== "true") {
				response.status(400).json({ detail: "Initial password setup is not available" });
				return;
			}
			if (admins.length !== 1) {
				response.status(400).json({ detail: "Initial administrator setup is not available" });
				return;
			}

			const admin = admins[0];
			const passwordHash = await hashPassword(password);
			const completed = await input.repository.completeInitialPasswordSetup({
				userId: admin.id,
				passwordHash,
				ipAddress: clientAddress(request),
			});
			if (!completed) {
				response.status(400).json({ detail: "Initial password setup is no longer available" });
				return;
			}

			await issueTokens({ ...admin, password_hash: passwordHash }, input.repository, input.config, response);
		} catch (error) {
			next(error);
		}
	});

	router.post("/login", async (request, response, next) => {
		try {
			const body = accountBody(request.body, response, { username: { type: "string" }, password: { type: "string" } });
			if (body === null) return;
			const username = body.username as string;
			const password = body.password as string;
			if (sendRateLimited(response, rateLimiter.check(`login:${clientAddress(request)}`, 10, 300))) return;

			const user = await input.repository.findUserByUsername(username);
			if (user === null || !(await verifyPassword(password, user.password_hash))) {
				response.status(401).json({ detail: "Invalid username or password" });
				return;
			}
			if (!user.is_active) {
				response.status(403).json({ detail: "Account is disabled" });
				return;
			}

			await input.repository.recordPasswordLogin({
				userId: user.id,
				isAdmin: user.role === "admin",
				ipAddress: clientAddress(request),
			});
			await issueTokens(user, input.repository, input.config, response);
		} catch (error) {
			next(error);
		}
	});

	router.post("/pin-login", async (request, response, next) => {
		try {
			const body = accountBody(request.body, response, {
				username: { type: "string" }, pin: { type: "string", minLength: 6, maxLength: 6, pattern: /^[0-9]{6}$/ },
			});
			if (body === null) return;
			const username = body.username as string;
			const pin = body.pin as string;
			if (sendRateLimited(response, rateLimiter.check(`pin:${clientAddress(request)}`, 5, 900))) return;

			const user = await input.repository.findUserByUsername(username);
			if (user === null || user.pin_hash === null || !(await verifyPin(pin, user.pin_hash))) {
				response.status(401).json({ detail: "Invalid username or PIN" });
				return;
			}
			if (!user.is_active) {
				response.status(403).json({ detail: "Account is disabled" });
				return;
			}

			await input.repository.recordPinLogin({ userId: user.id, ipAddress: clientAddress(request) });
			await issueTokens(user, input.repository, input.config, response, "pin");
		} catch (error) {
			next(error);
		}
	});

	router.post("/refresh", async (request, response, next) => {
		try {
			const refreshToken = refreshTokenFromCookie(request);
			if (refreshToken === null) {
				response.status(401).json({ detail: "No refresh token" });
				return;
			}

			const payload = await decodeRefreshToken(refreshToken, input.config);
			const userId = payload === null ? null : parseTokenSubject(payload.sub);
			if (userId === null) {
				response.status(401).json({ detail: "Invalid or expired refresh token" });
				return;
			}

			const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
			const stored = await input.repository.findRefreshTokenByHash(tokenHash);
			if (stored === null) {
				response.status(401).json({ detail: "Refresh token not found" });
				return;
			}
			if (stored.is_revoked) {
				clearRefreshCookie(response, input.config);
				response.status(401).json({ detail: "Refresh token already used" });
				return;
			}
			if (stored.user_id !== userId) {
				clearRefreshCookie(response, input.config);
				response.status(401).json({ detail: "Invalid or expired refresh token" });
				return;
			}

			const user = await input.repository.findActiveUserById(userId);
			if (user === null) {
				clearRefreshCookie(response, input.config);
				response.status(401).json({ detail: "User not found or inactive" });
				return;
			}

			const accessToken = await createAccessToken(user.id, user.role, input.config);
			const replacementRefreshToken = await createRefreshToken(user.id, input.config);
			const replacementPayload = await decodeRefreshToken(replacementRefreshToken, input.config);
			if (replacementPayload === null) throw new Error("Unable to create refresh token");

			const rotation = await input.repository.rotateRefreshToken({
				tokenHash,
				userId,
				replacementTokenHash: createHash("sha256").update(replacementRefreshToken).digest("hex"),
				replacementExpiresAt: new Date(replacementPayload.exp * 1000),
			});
			if (rotation === "not_found") {
				response.status(401).json({ detail: "Refresh token not found" });
				return;
			}
			if (rotation === "revoked") {
				clearRefreshCookie(response, input.config);
				response.status(401).json({ detail: "Refresh token already used" });
				return;
			}

			setRefreshCookie(response, replacementRefreshToken, input.config);
			response.json({ access_token: accessToken, user: userResponse(user) });
		} catch (error) {
			next(error);
		}
	});

	router.post("/logout", async (request, response, next) => {
		try {
			const refreshToken = refreshTokenFromCookie(request);
			if (refreshToken !== null) {
				await input.repository.revokeRefreshTokenByHash(
					createHash("sha256").update(refreshToken).digest("hex"),
				);
			}
			clearRefreshCookie(response, input.config);
			response.json({ detail: "Logged out" });
		} catch (error) {
			next(error);
		}
	});

	router.get("/me", authenticate, async (request, response) => {
		const user = await currentAccount(request, response);
		if (user !== null) response.json(userResponse(user));
	});

	router.put("/me", authenticate, async (request, response) => {
		const body = accountBody(request.body, response, {
			display_name: { type: "string", optional: true, nullable: true, maxLength: 10 },
			avatar_config: { type: "dict", optional: true, nullable: true },
		});
		if (body === null) return;
		const user = await currentAccount(request, response);
		if (user === null) return;
		await input.repository.updateProfile({
			userId: user.id,
			displayName: (body.display_name ?? undefined) as string | undefined,
			avatarConfig: (body.avatar_config ?? undefined) as Record<string, unknown> | undefined,
		});
		const updatedUser = await currentAccount(request, response);
		if (updatedUser !== null) response.json(userResponse(updatedUser));
	});

	router.post("/change-password", authenticate, async (request, response) => {
		const body = accountBody(request.body, response, {
			current_password: { type: "string" },
			new_password: { type: "string", minLength: 6 },
		});
		if (body === null) return;
		const user = await currentAccount(request, response);
		if (user === null) return;
		if (!(await verifyPassword(body.current_password as string, user.password_hash))) {
			response.status(400).json({ detail: "Current password is incorrect" });
			return;
		}
		const changed = await input.repository.changePassword({
			userId: user.id,
			expectedPasswordHash: user.password_hash,
			passwordHash: await hashPassword(body.new_password as string),
			ipAddress: clientAddress(request),
		});
		if (!changed) {
			response.status(400).json({ detail: "Current password is incorrect" });
			return;
		}
		response.json({ detail: "Password changed. Please log in again." });
	});

	router.post("/set-pin", authenticate, async (request, response) => {
		const body = accountBody(request.body, response, {
			pin: { type: "string", minLength: 6, maxLength: 6, pattern: /^[0-9]{6}$/ },
		});
		if (body === null) return;
		const user = await currentAccount(request, response);
		if (user === null) return;
		await input.repository.setPin({ userId: user.id, pinHash: await hashPin(body.pin as string) });
		response.json({ detail: "PIN set successfully" });
	});

	return router;
}
