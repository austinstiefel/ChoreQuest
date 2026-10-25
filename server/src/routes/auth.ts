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
		passwordHash: string;
		ipAddress: string | null;
	}): Promise<void>;
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

type RawUserRecord = Omit<AuthUserRecord, "avatar_config"> & { avatar_config: unknown | null };

class InitialSetupUnavailableError extends Error {}

function parseAvatarConfig(value: unknown): unknown | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return JSON.parse(value) as unknown;
	return value;
}

function toAuthUserRecord(user: RawUserRecord): AuthUserRecord {
	return {
		...user,
		avatar_config: parseAvatarConfig(user.avatar_config),
	};
}

/**
 * Build the persistence adapter for the existing SQLite schema. Prisma marks
 * the legacy JSON columns as Unsupported, so user reads and audit JSON writes
 * use parameterized SQL while all other access uses the generated client.
 */
export function createPrismaAuthRepository(prisma: PrismaClient): AuthRepository {
	return {
		...createPrismaAuthUserRepository(prisma),
		async findFirstActiveAdmin() {
			const rows = await prisma.$queryRaw<RawUserRecord[]>`
        SELECT id, username, display_name, password_hash, pin_hash, role,
          points_balance, total_points_earned, current_streak, longest_streak,
          streak_freezes_used, streak_freeze_month, avatar_config, is_active, created_at
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
          streak_freezes_used, streak_freeze_month, avatar_config, is_active, created_at
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
          streak_freezes_used, streak_freeze_month, avatar_config, is_active, created_at
        FROM users
        WHERE username = ${username}
        LIMIT 1
      `;
			return rows[0] === undefined ? null : toAuthUserRecord(rows[0]);
		},

		async completeInitialPasswordSetup(input) {
			try {
				return await prisma.$transaction(async (tx) => {
					const now = new Date();
					const transition = await tx.app_settings.updateMany({
						where: { key: SETUP_COMPLETE_KEY, value: "false" },
						data: { value: "true", updated_at: now },
					});
					if (transition.count !== 1) throw new InitialSetupUnavailableError();

					const passwordSetup = await tx.app_settings.updateMany({
						where: { key: INITIAL_PASSWORD_SETUP_REQUIRED_KEY, value: "true" },
						data: { value: "false", updated_at: now },
					});
					if (passwordSetup.count !== 1) throw new InitialSetupUnavailableError();

					await tx.users.update({
						where: { id: input.userId },
						data: { password_hash: input.passwordHash, updated_at: now },
					});
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
				const now = new Date();
				await tx.$executeRaw`
          INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
          VALUES (${input.userId}, ${"login"}, ${'{"method":"password"}'}, ${input.ipAddress}, ${now})
        `;
				if (input.isAdmin) {
					await tx.app_settings.updateMany({
						where: { key: SETUP_COMPLETE_KEY, value: "false" },
						data: { value: "true", updated_at: now },
					});
				}
			});
		},

		async recordPinLogin(input) {
			const now = new Date();
			await prisma.$executeRaw`
        INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
        VALUES (${input.userId}, ${"login"}, ${'{"method":"pin"}'}, ${input.ipAddress}, ${now})
      `;
		},

		async storeRefreshToken(input) {
			await prisma.refresh_tokens.create({
				data: {
					user_id: input.userId,
					token_hash: input.tokenHash,
					is_revoked: false,
					expires_at: input.expiresAt,
					created_at: new Date(),
				},
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
          streak_freezes_used, streak_freeze_month, avatar_config, is_active, created_at
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
					await tx.refresh_tokens.create({
						data: {
							user_id: input.userId,
							token_hash: input.replacementTokenHash,
							is_revoked: false,
							expires_at: input.replacementExpiresAt,
							created_at: new Date(),
						},
					});
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
          updated_at = ${new Date()}
        WHERE id = ${input.userId}
      `;
		},

		async changePassword(input) {
			await prisma.$transaction(async (tx) => {
				const now = new Date();
				await tx.users.update({
					where: { id: input.userId },
					data: { password_hash: input.passwordHash, updated_at: now },
				});
				await tx.refresh_tokens.updateMany({
					where: { user_id: input.userId, is_revoked: false },
					data: { is_revoked: true },
				});
				await tx.$executeRaw`
          INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
          VALUES (${input.userId}, ${"password_change"}, ${"{}"}, ${input.ipAddress}, ${now})
        `;
			});
		},

		async setPin(input) {
			await prisma.users.update({
				where: { id: input.userId },
				data: { pin_hash: input.pinHash, updated_at: new Date() },
			});
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

function validationError(
	response: Response,
	field: string,
	message: string,
	type: string,
	context?: Record<string, unknown>,
): void {
	// FastAPI returns 422 for request-model validation. Deliberately omit its
	// echo of `input` so passwords and PINs are never reflected to the client.
	response.status(422).json({
		detail: [{ type, loc: ["body", field], msg: message, ...(context === undefined ? {} : { ctx: context }) }],
	});
}

function stringField(body: unknown, field: string): string | null {
	if (typeof body !== "object" || body === null) return null;
	const value = (body as Record<string, unknown>)[field];
	return typeof value === "string" ? value : null;
}

interface AccountFieldRule {
	type: "string" | "dict";
	optional?: boolean;
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
}

/** Pydantic-style account validation; extra fields are ignored, inputs are not echoed. */
function accountBody(
	body: unknown,
	response: Response,
	rules: Record<string, AccountFieldRule>,
): Record<string, unknown> | null {
	if (body === undefined) {
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
	const values = body as Record<string, unknown>;
	const errors: Array<{
		type: string;
		loc: string[];
		msg: string;
		ctx?: Record<string, unknown>;
	}> = [];
	for (const [field, rule] of Object.entries(rules)) {
		const value = values[field];
		const loc = ["body", field];
		if (rule.optional && (value === undefined || value === null)) continue;
		if (value === undefined) {
			errors.push({ type: "missing", loc, msg: "Field required" });
		} else if (rule.type === "dict") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				errors.push({ type: "dict_type", loc, msg: "Input should be a valid dictionary" });
			}
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

function userResponse(user: AuthUserRecord) {
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

	for (const segment of cookieHeader.split(";")) {
		const [name, ...value] = segment.trim().split("=");
		if (name === REFRESH_COOKIE_NAME) return value.join("=") || null;
	}
	return null;
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
): Promise<void> {
	const accessToken = await createAccessToken(user.id, user.role, config);
	const refreshToken = await createRefreshToken(user.id, config);
	const refreshPayload = await decodeRefreshToken(refreshToken, config);
	if (refreshPayload === null) throw new Error("Unable to create refresh token");

	await repository.storeRefreshToken({
		userId: user.id,
		tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
		expiresAt: new Date(refreshPayload.exp * 1000),
	});

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
			const password = stringField(request.body, "password");
			const confirmation = stringField(request.body, "confirm_password");
			if (password === null) {
				validationError(response, "password", "Field required", "missing");
				return;
			}
			if (password.length < 6) {
				validationError(response, "password", "String should have at least 6 characters", "string_too_short", { min_length: 6 });
				return;
			}
			if (confirmation === null) {
				validationError(response, "confirm_password", "Field required", "missing");
				return;
			}
			if (confirmation.length < 6) {
				validationError(response, "confirm_password", "String should have at least 6 characters", "string_too_short", { min_length: 6 });
				return;
			}
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
			const completed = await input.repository.completeInitialPasswordSetup({
				userId: admin.id,
				passwordHash: await hashPassword(password),
				ipAddress: clientAddress(request),
			});
			if (!completed) {
				response.status(400).json({ detail: "Initial password setup is no longer available" });
				return;
			}

			await issueTokens(admin, input.repository, input.config, response);
		} catch (error) {
			next(error);
		}
	});

	router.post("/login", async (request, response, next) => {
		try {
			const username = stringField(request.body, "username");
			const password = stringField(request.body, "password");
			if (username === null) {
				validationError(response, "username", "Field required", "missing");
				return;
			}
			if (password === null) {
				validationError(response, "password", "Field required", "missing");
				return;
			}
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
			const username = stringField(request.body, "username");
			const pin = stringField(request.body, "pin");
			if (username === null) {
				validationError(response, "username", "Field required", "missing");
				return;
			}
			if (pin === null) {
				validationError(response, "pin", "Field required", "missing");
				return;
			}
			if (!/^[0-9]{6}$/.test(pin)) {
				validationError(response, "pin", "String should match pattern '^\\d{6}$'", "string_pattern_mismatch", { pattern: "^\\d{6}$" });
				return;
			}
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
			await issueTokens(user, input.repository, input.config, response);
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
			display_name: { type: "string", optional: true, maxLength: 10 },
			avatar_config: { type: "dict", optional: true },
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
		await input.repository.changePassword({
			userId: user.id,
			passwordHash: await hashPassword(body.new_password as string),
			ipAddress: clientAddress(request),
		});
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
