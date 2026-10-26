import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, hashPin, verifyPassword, verifyPin } from "../../src/auth/passwords.js";
import {
	createAccessToken,
	createRefreshToken,
	decodeAccessToken,
	decodeRefreshToken,
} from "../../src/auth/tokens.js";
import { createApp } from "../../src/app.js";
import type { AuthConfig } from "../../src/config/auth.js";
import {
	createAuthRouter,
	type AuthRepository,
	type AuthUserRecord,
	SlidingWindowRateLimiter,
} from "../../src/routes/auth.js";

const config: AuthConfig = {
	secretKey: "phase3d1-test-secret-at-least-16",
	accessTokenExpireMinutes: 15,
	refreshTokenExpireDays: 30,
	cookieSecure: false,
	corsOrigins: [],
};

type AuditEntry = {
	userId: number;
	action: string;
	details: Record<string, string>;
	ipAddress: string | null;
};

class InMemoryAuthRepository implements AuthRepository {
	readonly settings = new Map<string, string>();
	readonly audits: AuditEntry[] = [];
	readonly refreshTokens: Array<{
		id: number;
		userId: number;
		tokenHash: string;
		isRevoked: boolean;
		expiresAt: Date;
	}> = [];

	constructor(readonly users: AuthUserRecord[]) {}

	async findUserById(userId: number) {
		const user = this.users.find((candidate) => candidate.id === userId);
		if (user === undefined) return null;
		const { id, username, display_name, role, is_active } = user;
		return { id, username, display_name, role, is_active };
	}

	async updateProfile(input: Parameters<AuthRepository["updateProfile"]>[0]): Promise<void> {
		const user = this.users.find((candidate) => candidate.id === input.userId)!;
		if (input.displayName !== undefined) user.display_name = input.displayName;
		if (input.avatarConfig !== undefined) user.avatar_config = input.avatarConfig;
	}

	async changePassword(input: Parameters<AuthRepository["changePassword"]>[0]): Promise<boolean> {
		const user = this.users.find((candidate) => candidate.id === input.userId)!;
		if (!user.is_active || user.password_hash !== input.expectedPasswordHash) return false;
		user.password_hash = input.passwordHash;
		for (const token of this.refreshTokens) {
			if (token.userId === user.id) token.isRevoked = true;
		}
		this.audits.push({ userId: user.id, action: "password_change", details: {}, ipAddress: input.ipAddress });
		return true;
	}

	async setPin(input: Parameters<AuthRepository["setPin"]>[0]): Promise<void> {
		this.users.find((candidate) => candidate.id === input.userId)!.pin_hash = input.pinHash;
	}

	async findFirstActiveAdmin(): Promise<AuthUserRecord | null> {
		return this.users.find((user) => user.role === "admin" && user.is_active) ?? null;
	}

	async findActiveAdmins(): Promise<AuthUserRecord[]> {
		return this.users.filter((user) => user.role === "admin" && user.is_active);
	}

	async findSetting(key: string): Promise<string | null> {
		return this.settings.get(key) ?? null;
	}

	async findUserByUsername(username: string): Promise<AuthUserRecord | null> {
		return this.users.find((user) => user.username === username) ?? null;
	}

	async completeInitialPasswordSetup(input: {
		userId: number;
		passwordHash: string;
		ipAddress: string | null;
	}): Promise<boolean> {
		if (
			this.settings.get("initial_setup_complete") !== "false" ||
			this.settings.get("initial_password_setup_required") !== "true"
		) {
			return false;
		}

		const user = this.users.find((candidate) => candidate.id === input.userId);
		if (user === undefined) throw new Error("setup administrator disappeared");

		this.settings.set("initial_setup_complete", "true");
		this.settings.set("initial_password_setup_required", "false");
		user.password_hash = input.passwordHash;
		this.audits.push({
			userId: input.userId,
			action: "initial_password_setup",
			details: {},
			ipAddress: input.ipAddress,
		});
		return true;
	}

	async recordPasswordLogin(input: {
		userId: number;
		isAdmin: boolean;
		ipAddress: string | null;
	}): Promise<void> {
		this.audits.push({
			userId: input.userId,
			action: "login",
			details: { method: "password" },
			ipAddress: input.ipAddress,
		});
		if (input.isAdmin && this.settings.get("initial_setup_complete") === "false") {
			this.settings.set("initial_setup_complete", "true");
		}
	}

	async recordPinLogin(input: { userId: number; ipAddress: string | null }): Promise<void> {
		this.audits.push({
			userId: input.userId,
			action: "login",
			details: { method: "pin" },
			ipAddress: input.ipAddress,
		});
	}

	async storeRefreshToken(input: {
		userId: number;
		tokenHash: string;
		expiresAt: Date;
	}): Promise<void> {
		this.refreshTokens.push({
			id: this.refreshTokens.length + 1,
			...input,
			isRevoked: false,
		});
	}

	async findRefreshTokenByHash(tokenHash: string) {
		const token = this.refreshTokens.find((candidate) => candidate.tokenHash === tokenHash);
		return token === undefined
			? null
			: { id: token.id, user_id: token.userId, is_revoked: token.isRevoked };
	}

	async findActiveUserById(userId: number): Promise<AuthUserRecord | null> {
		return this.users.find((candidate) => candidate.id === userId && candidate.is_active) ?? null;
	}

	async rotateRefreshToken(input: {
		tokenHash: string;
		userId: number;
		replacementTokenHash: string;
		replacementExpiresAt: Date;
	}): Promise<"rotated" | "not_found" | "revoked"> {
		const token = this.refreshTokens.find((candidate) => candidate.tokenHash === input.tokenHash);
		if (token === undefined) return "not_found";
		if (token.userId !== input.userId || token.isRevoked) return "revoked";

		token.isRevoked = true;
		this.refreshTokens.push({
			id: this.refreshTokens.length + 1,
			userId: input.userId,
			tokenHash: input.replacementTokenHash,
			isRevoked: false,
			expiresAt: input.replacementExpiresAt,
		});
		return "rotated";
	}

	async revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
		const token = this.refreshTokens.find((candidate) => candidate.tokenHash === tokenHash);
		if (token !== undefined && !token.isRevoked) token.isRevoked = true;
	}
}

function user(overrides: Partial<AuthUserRecord> = {}): AuthUserRecord {
	return {
		id: 1,
		username: "Admin",
		display_name: "Administrator",
		password_hash: "not-a-valid-password-hash",
		pin_hash: null,
		role: "admin",
		points_balance: 0,
		total_points_earned: 0,
		current_streak: 0,
		longest_streak: 0,
		streak_freezes_used: 0,
		streak_freeze_month: null,
		avatar_config: { item: "default" },
		is_active: true,
		created_at: new Date("2030-01-02T03:04:05.000Z"),
		...overrides,
	};
}

function authApp(repository: AuthRepository, rateLimiter = new SlidingWindowRateLimiter()) {
	return createApp(createAuthRouter({ config, repository, rateLimiter }));
}

function refreshCookie(token: string): string {
	return `refresh_token=${token}`;
}

async function persistRefreshToken(
	repository: InMemoryAuthRepository,
	token: string,
	userId = 1,
): Promise<void> {
	const payload = await decodeRefreshToken(token, config);
	if (payload === null) throw new Error("test refresh token must be valid");
	await repository.storeRefreshToken({
		userId,
		tokenHash: createHash("sha256").update(token).digest("hex"),
		expiresAt: new Date(payload.exp * 1000),
	});
}

describe("public authentication endpoints", () => {
	let repository: InMemoryAuthRepository;

	beforeEach(() => {
		repository = new InMemoryAuthRepository([user()]);
	});

	it("reports fresh, configured-password, and completed setup state", async () => {
		const fresh = authApp(new InMemoryAuthRepository([]));
		await request(fresh).get("/api/auth/setup-status").expect(200, {
			setup_required: true,
			admin_username: null,
			password_setup_required: false,
		});

		repository.settings.set("initial_setup_complete", "false");
		repository.settings.set("initial_password_setup_required", "true");
		await request(authApp(repository)).get("/api/auth/setup-status").expect(200, {
			setup_required: true,
			admin_username: "Admin",
			password_setup_required: true,
		});

		repository.settings.set("initial_setup_complete", "true");
		await request(authApp(repository)).get("/api/auth/setup-status").expect(200, {
			setup_required: false,
			admin_username: "Admin",
			password_setup_required: false,
		});
	});

	it("sets the initial password once, issues compatible credentials, and records no secret", async () => {
		repository.settings.set("initial_setup_complete", "false");
		repository.settings.set("initial_password_setup_required", "true");
		const response = await request(authApp(repository))
			.post("/api/auth/setup-password")
			.send({ password: "NewPassword42", confirm_password: "NewPassword42" })
			.expect(200);

		expect(response.body.user).toEqual({
			id: 1,
			username: "Admin",
			display_name: "Administrator",
			role: "admin",
			points_balance: 0,
			total_points_earned: 0,
			current_streak: 0,
			longest_streak: 0,
			streak_freezes_used: 0,
			streak_freeze_month: null,
			avatar_config: { item: "default" },
			is_active: true,
			created_at: "2030-01-02T03:04:05.000Z",
		});
		await expect(decodeAccessToken(response.body.access_token, config)).resolves.toMatchObject({
			sub: "1",
			role: "admin",
			type: "access",
		});
		expect(response.headers["set-cookie"][0]).toMatch(
			/^refresh_token=.*; HttpOnly; Max-Age=2592000; Path=\/api\/auth; SameSite=lax$/,
		);
		expect(repository.settings).toMatchObject(new Map([
			["initial_setup_complete", "true"],
			["initial_password_setup_required", "false"],
		]));
		await expect(verifyPassword("NewPassword42", repository.users[0].password_hash)).resolves.toBe(true);
		expect(repository.audits).toEqual([
			expect.objectContaining({ action: "initial_password_setup", details: {} }),
		]);
		expect(JSON.stringify(repository.audits)).not.toContain("NewPassword42");
		expect(repository.refreshTokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(repository.refreshTokens[0].tokenHash).not.toBe(response.headers["set-cookie"][0]);
	});

	it("rejects invalid initial-password requests and setup states", async () => {
		repository.settings.set("initial_setup_complete", "false");
		repository.settings.set("initial_password_setup_required", "true");
		const app = authApp(repository);
		await request(app)
			.post("/api/auth/setup-password")
			.send({ password: "NewPassword42", confirm_password: "DifferentPassword42" })
			.expect(400, { detail: "Passwords do not match" });
		const tooShort = await request(app)
			.post("/api/auth/setup-password")
			.send({ password: "short", confirm_password: "short" })
			.expect(422);
		expect(tooShort.body.detail[0]).not.toHaveProperty("input");

		repository.settings.set("initial_setup_complete", "true");
		await request(app)
			.post("/api/auth/setup-password")
			.send({ password: "NewPassword42", confirm_password: "NewPassword42" })
			.expect(400, { detail: "Initial password setup is not available" });

		repository.settings.set("initial_setup_complete", "false");
		repository.users.push(user({ id: 2, username: "OtherAdmin" }));
		await request(app)
			.post("/api/auth/setup-password")
			.send({ password: "NewPassword42", confirm_password: "NewPassword42" })
			.expect(400, { detail: "Initial administrator setup is not available" });
	});

	it("allows only one concurrent initial password transition", async () => {
		repository.settings.set("initial_setup_complete", "false");
		repository.settings.set("initial_password_setup_required", "true");
		const app = authApp(repository);
		const body = { password: "NewPassword42", confirm_password: "NewPassword42" };
		const responses = await Promise.all([
			request(app).post("/api/auth/setup-password").send(body),
			request(app).post("/api/auth/setup-password").send(body),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
		expect(repository.audits).toHaveLength(1);
		expect(repository.refreshTokens).toHaveLength(1);
	});

	it("logs in with a password, completes configured admin setup, and stores only a refresh hash", async () => {
		repository.users[0].password_hash = await hashPassword("ConfiguredPassword42");
		repository.settings.set("initial_setup_complete", "false");
		repository.settings.set("initial_password_setup_required", "false");
		const response = await request(authApp(repository))
			.post("/api/auth/login")
			.send({ username: "Admin", password: "ConfiguredPassword42" })
			.expect(200);

		expect(repository.settings.get("initial_setup_complete")).toBe("true");
		expect(repository.audits).toEqual([
			expect.objectContaining({ action: "login", details: { method: "password" } }),
		]);
		expect(JSON.stringify(repository.audits)).not.toContain("ConfiguredPassword42");
		const refreshToken = /refresh_token=([^;]+)/.exec(response.headers["set-cookie"][0])?.[1];
		expect(refreshToken).toBeDefined();
		if (refreshToken === undefined) throw new Error("Missing refresh cookie");
		expect(repository.refreshTokens[0].tokenHash).toBe(
			createHash("sha256").update(refreshToken).digest("hex"),
		);
	});

	it("distinguishes invalid and disabled password-login accounts", async () => {
		repository.users[0].password_hash = await hashPassword("ConfiguredPassword42");
		const app = authApp(repository);
		await request(app)
			.post("/api/auth/login")
			.send({ username: "Unknown", password: "ConfiguredPassword42" })
			.expect(401, { detail: "Invalid username or password" });
		await request(app)
			.post("/api/auth/login")
			.send({ username: "Admin", password: "wrong" })
			.expect(401, { detail: "Invalid username or password" });
		repository.users[0].is_active = false;
		await request(app)
			.post("/api/auth/login")
			.send({ username: "Admin", password: "ConfiguredPassword42" })
			.expect(403, { detail: "Account is disabled" });
	});

	it("treats a malformed stored password hash as invalid credentials", async () => {
		repository.users[0].password_hash = "$2b$12$malformed-bcrypt-hash";
		const response = await request(authApp(repository))
			.post("/api/auth/login")
			.send({ username: "Admin", password: "ConfiguredPassword42" })
			.expect(401, { detail: "Invalid username or password" });

		expect(JSON.stringify(response.body)).not.toContain(repository.users[0].password_hash);
		expect(repository.audits).toHaveLength(0);
	});

	it("logs in with an ASCII six-digit PIN and rejects malformed, invalid, missing, and disabled accounts", async () => {
		repository.users[0].pin_hash = await hashPin("123456");
		const app = authApp(repository);
		await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Admin", pin: "123456" })
			.expect(200);
		expect(repository.audits[0]).toMatchObject({ action: "login", details: { method: "pin" } });
		const malformed = await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Admin", pin: "12345a" })
			.expect(422);
		expect(malformed.body.detail[0]).not.toHaveProperty("input");
		await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Admin", pin: "654321" })
			.expect(401, { detail: "Invalid username or PIN" });
		await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Unknown", pin: "123456" })
			.expect(401, { detail: "Invalid username or PIN" });
		repository.users[0].is_active = false;
		await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Admin", pin: "123456" })
			.expect(403, { detail: "Account is disabled" });
	});

	it("uses independent Python-compatible limits, resets injected state, and exposes no public registration route", async () => {
		const app = authApp(repository);
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await request(app)
				.post("/api/auth/login")
				.send({ username: "Unknown", password: "anything" })
				.expect(401);
		}
		const limited = await request(app)
			.post("/api/auth/login")
			.send({ username: "Unknown", password: "anything" })
			.expect(429, { detail: "Too many requests" });
		expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
		await request(authApp(repository))
			.post("/api/auth/login")
			.send({ username: "Unknown", password: "anything" })
			.expect(401);

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await request(app)
				.post("/api/auth/setup-password")
				.send({ password: "NewPassword42", confirm_password: "NewPassword42" })
				.expect(400, { detail: "Initial password setup is not available" });
		}
		await request(app)
			.post("/api/auth/setup-password")
			.send({ password: "NewPassword42", confirm_password: "NewPassword42" })
			.expect(429, { detail: "Too many requests" });

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await request(app)
				.post("/api/auth/pin-login")
				.send({ username: "Unknown", pin: "123456" })
				.expect(401, { detail: "Invalid username or PIN" });
		}
		await request(app)
			.post("/api/auth/pin-login")
			.send({ username: "Unknown", pin: "123456" })
			.expect(429, { detail: "Too many requests" });
		await request(app).post("/api/auth/register").send({}).expect(404);
	});

	it("rejects missing, invalid, expired, malformed, and wrong-type refresh tokens", async () => {
		const app = authApp(repository);
		await request(app).post("/api/auth/refresh").expect(401, { detail: "No refresh token" });
		await request(app).post("/api/auth/refresh").set("Cookie", 'refresh_token=""').expect(401, { detail: "No refresh token" });

		const expired = await new SignJWT({ type: "refresh", exp: 1 })
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setSubject("1")
			.sign(new TextEncoder().encode(config.secretKey));
		const access = await createAccessToken(1, "admin", config);
		for (const token of ["not-a-jwt", expired, access]) {
			const response = await request(app)
				.post("/api/auth/refresh")
				.set("Cookie", refreshCookie(token))
				.expect(401, { detail: "Invalid or expired refresh token" });
			expect(response.headers["set-cookie"]).toBeUndefined();
		}
	});

	it("rejects unknown, revoked, deleted, and inactive refresh-token sessions with Python-compatible cookie behavior", async () => {
		const app = authApp(repository);
		const unknown = await createRefreshToken(1, config);
		const unknownResponse = await request(app)
			.post("/api/auth/refresh")
			.set("Cookie", refreshCookie(unknown))
			.expect(401, { detail: "Refresh token not found" });
		expect(unknownResponse.headers["set-cookie"]).toBeUndefined();

		const revoked = await createRefreshToken(1, config);
		await persistRefreshToken(repository, revoked);
		repository.refreshTokens[0].isRevoked = true;
		const revokedResponse = await request(app)
			.post("/api/auth/refresh")
			.set("Cookie", refreshCookie(revoked))
			.expect(401, { detail: "Refresh token already used" });
		expect(revokedResponse.headers["set-cookie"][0]).toBe(
			'refresh_token=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/api/auth; SameSite=lax',
		);

		const deletedRepository = new InMemoryAuthRepository([]);
		const deleted = await createRefreshToken(1, config);
		await persistRefreshToken(deletedRepository, deleted);
		await request(authApp(deletedRepository))
			.post("/api/auth/refresh")
			.set("Cookie", refreshCookie(deleted))
			.expect(401, { detail: "User not found or inactive" })
			.expect("Set-Cookie", /Max-Age=0/);

		repository.users[0].is_active = false;
		const inactive = await createRefreshToken(1, config);
		await persistRefreshToken(repository, inactive);
		await request(app)
			.post("/api/auth/refresh")
			.set("Cookie", refreshCookie(inactive))
			.expect(401, { detail: "User not found or inactive" })
			.expect("Set-Cookie", /Max-Age=0/);
	});

	it("rotates a refresh token atomically and persists only the replacement hash", async () => {
		const original = await createRefreshToken(1, config);
		await persistRefreshToken(repository, original);
		const response = await request(authApp(repository))
			.post("/api/auth/refresh")
			.set("Cookie", `refresh_token=ignored-duplicate; refresh_token="${original}"`)
			.expect(200);

		expect(response.body.user).toMatchObject({ id: 1, username: "Admin", role: "admin" });
		await expect(decodeAccessToken(response.body.access_token, config)).resolves.toMatchObject({
			sub: "1",
			type: "access",
		});
		const replacement = /refresh_token=([^;]+)/.exec(response.headers["set-cookie"][0])?.[1];
		expect(replacement).toBeDefined();
		if (replacement === undefined) throw new Error("Missing replacement refresh cookie");
		expect(replacement).not.toBe(original);
		expect(response.headers["set-cookie"][0]).toMatch(
			/^refresh_token=.*; HttpOnly; Max-Age=2592000; Path=\/api\/auth; SameSite=lax$/,
		);
		expect(repository.refreshTokens).toHaveLength(2);
		expect(repository.refreshTokens[0]).toMatchObject({ isRevoked: true });
		expect(repository.refreshTokens[1]).toMatchObject({
			isRevoked: false,
			tokenHash: createHash("sha256").update(replacement).digest("hex"),
		});
		expect(repository.refreshTokens.map((token) => token.tokenHash)).not.toContain(original);
	});

	it("allows only one concurrent refresh rotation from the same token", async () => {
		const original = await createRefreshToken(1, config);
		await persistRefreshToken(repository, original);
		const app = authApp(repository);
		const responses = await Promise.all([
			request(app).post("/api/auth/refresh").set("Cookie", refreshCookie(original)),
			request(app).post("/api/auth/refresh").set("Cookie", refreshCookie(original)),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
		expect(responses.find((response) => response.status === 401)?.body).toEqual({
			detail: "Refresh token already used",
		});
		expect(repository.refreshTokens).toHaveLength(2);
		expect(repository.refreshTokens.filter((token) => !token.isRevoked)).toHaveLength(1);
	});

	it("uses the generic error response for refresh repository failures", async () => {
		class FailingRepository extends InMemoryAuthRepository {
			override async findRefreshTokenByHash(): Promise<null> {
				throw new Error("database connection secret detail");
			}
		}
		const failingRepository = new FailingRepository([user()]);
		const token = await createRefreshToken(1, config);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await request(authApp(failingRepository))
			.post("/api/auth/refresh")
			.set("Cookie", refreshCookie(token))
			.expect(500);

		expect(response.body).toEqual({
			error: "Internal Server Error",
			message: "An unexpected error occurred.",
		});
		expect(JSON.stringify(response.body)).not.toContain("secret detail");
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("logs out without requiring a decodable token and always clears the cookie", async () => {
		const app = authApp(repository);
		for (const token of [undefined, "unknown-token", "malformed-token"]) {
			const response = token === undefined
				? await request(app).post("/api/auth/logout").expect(200, { detail: "Logged out" })
				: await request(app)
						.post("/api/auth/logout")
						.set("Cookie", refreshCookie(token))
						.expect(200, { detail: "Logged out" });
			expect(response.headers["set-cookie"][0]).toMatch(
				/^refresh_token=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=\/api\/auth; SameSite=lax$/,
			);
		}

		const known = await createRefreshToken(1, config);
		await persistRefreshToken(repository, known);
		await request(app)
			.post("/api/auth/logout")
			.set("Cookie", refreshCookie(known))
			.expect(200, { detail: "Logged out" });
		expect(repository.refreshTokens[0].isRevoked).toBe(true);

		const alreadyRevoked = await createRefreshToken(1, config);
		await persistRefreshToken(repository, alreadyRevoked);
		repository.refreshTokens[1].isRevoked = true;
		await request(app)
			.post("/api/auth/logout")
			.set("Cookie", refreshCookie(alreadyRevoked))
			.expect(200, { detail: "Logged out" });
		expect(repository.refreshTokens[1].isRevoked).toBe(true);
	});

	it("requires active access-token authentication on all four account routes", async () => {
		const app = authApp(repository);
		const expired = await new SignJWT({ type: "access", role: "admin", exp: 1 })
			.setProtectedHeader({ alg: "HS256" }).setSubject("1")
			.sign(new TextEncoder().encode(config.secretKey));
		const refresh = await createRefreshToken(1, config);
		for (const [method, path] of [
			["get", "/me"], ["put", "/me"], ["post", "/change-password"], ["post", "/set-pin"],
		] as const) {
			await request(app)[method](`/api/auth${path}`).expect(401, { detail: "Not authenticated" });
			for (const token of ["malformed", expired, refresh]) {
				await request(app)[method](`/api/auth${path}`)
					.set("Authorization", `Bearer ${token}`)
					.expect(401, { detail: "Invalid or expired token" });
			}
			for (const user of [undefined, { ...repository.users[0], is_active: false }]) {
				const unavailable = new InMemoryAuthRepository(user === undefined ? [] : [user]);
				await request(authApp(unavailable))[method](`/api/auth${path}`)
					.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
					.expect(401, { detail: "User not found or inactive" });
			}
		}
	});

	it("returns the full current profile and database role without credential fields", async () => {
		const token = await createAccessToken(1, "admin", config);
		repository.users[0].role = "kid";
		const response = await request(authApp(repository)).get("/api/auth/me")
			.set("Authorization", `Bearer ${token}`).expect(200);
		const { password_hash, pin_hash, ...expected } = repository.users[0];
		expect(response.body).toEqual({ ...expected, created_at: expected.created_at.toISOString() });
		expect(response.body).not.toHaveProperty("password_hash");
		expect(response.body).not.toHaveProperty("pin_hash");
	});

	it("updates only profile fields, preserves omitted/null fields, and ignores unauthorized fields", async () => {
		const app = authApp(repository);
		const authorization = `Bearer ${await createAccessToken(1, "kid", config)}`;
		await request(app).put("/api/auth/me").set("Authorization", authorization)
			.send({ display_name: "New Name" }).expect(200);
		expect(repository.users[0]).toMatchObject({ display_name: "New Name", avatar_config: { item: "default" } });
		await request(app).put("/api/auth/me").set("Authorization", authorization)
			.send({ avatar_config: { hat: "blue", nested: { enabled: true }, items: [1, null] } }).expect(200);
		expect(repository.users[0].display_name).toBe("New Name");
		await request(app).put("/api/auth/me").set("Authorization", authorization)
			.send({ display_name: "", avatar_config: {} }).expect(200);
		const before = structuredClone(repository.users[0]);
		for (const body of [{}, { display_name: null, avatar_config: null }, {
			username: "hijacked", role: "kid", points_balance: 999, is_active: false,
			password_hash: "unsafe", pin_hash: "unsafe", id: 2,
		}]) {
			await request(app).put("/api/auth/me").set("Authorization", authorization).send(body).expect(200);
			expect(repository.users[0]).toEqual(before);
		}
		await request(app).put("/api/auth/me").set("Authorization", authorization)
			.send({ display_name: "😀".repeat(10) }).expect(200);
	});

	it.each([
		{ display_name: 10 }, { display_name: [] }, { display_name: "12345678901" },
		{ avatar_config: [] }, { avatar_config: "invalid" }, { avatar_config: true },
	])("rejects invalid profile fields: %j", async (body) => {
		const before = structuredClone(repository.users[0]);
		const response = await request(authApp(repository)).put("/api/auth/me")
			.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
			.send(body).expect(422);
		expect(response.body.detail[0]).toHaveProperty("loc");
		expect(repository.users[0]).toEqual(before);
	});

	it("returns Pydantic-compatible account validation details without echoing sensitive inputs", async () => {
		const app = authApp(repository);
		const authorization = `Bearer ${await createAccessToken(1, "admin", config)}`;
		const profile = await request(app).put("/api/auth/me").set("Authorization", authorization)
			.send({ display_name: "12345678901", avatar_config: [] }).expect(422);
		expect(profile.body).toEqual({ detail: [
			{ type: "string_too_long", loc: ["body", "display_name"], msg: "String should have at most 10 characters", ctx: { max_length: 10 } },
			{ type: "dict_type", loc: ["body", "avatar_config"], msg: "Input should be a valid dictionary" },
		] });
		const password = await request(app).post("/api/auth/change-password").set("Authorization", authorization)
			.send({ current_password: null, new_password: "short" }).expect(422);
		expect(password.body).toEqual({ detail: [
			{ type: "string_type", loc: ["body", "current_password"], msg: "Input should be a valid string" },
			{ type: "string_too_short", loc: ["body", "new_password"], msg: "String should have at least 6 characters", ctx: { min_length: 6 } },
		] });
		await request(app).put("/api/auth/me").set("Authorization", authorization).send([]).expect(422);
		await request(app).put("/api/auth/me").set("Authorization", authorization)
			.expect(422, { detail: [{ type: "missing", loc: ["body"], msg: "Field required" }] });
	});

	it("changes a password, audits it, and revokes only that user's sessions while access tokens still work", async () => {
		repository.users[0].password_hash = await hashPassword("OriginalPassword42");
		repository.users.push(user({ id: 2, username: "Other" }));
		for (const userId of [1, 1, 2]) {
			await persistRefreshToken(repository, await createRefreshToken(userId, config), userId);
		}
		const app = authApp(repository);
		const authorization = `Bearer ${await createAccessToken(1, "admin", config)}`;
		const response = await request(app).post("/api/auth/change-password").set("Authorization", authorization)
			.send({ current_password: "OriginalPassword42", new_password: "ReplacementPassword42" })
			.expect(200, { detail: "Password changed. Please log in again." });
		expect(response.headers["set-cookie"]).toBeUndefined();
		await expect(verifyPassword("ReplacementPassword42", repository.users[0].password_hash)).resolves.toBe(true);
		await expect(verifyPassword("OriginalPassword42", repository.users[0].password_hash)).resolves.toBe(false);
		expect(repository.refreshTokens.map((token) => token.isRevoked)).toEqual([true, true, false]);
		expect(repository.audits).toEqual([{ userId: 1, action: "password_change", details: {}, ipAddress: expect.any(String) }]);
		expect(JSON.stringify(repository.audits)).not.toContain("Password42");
		await request(app).get("/api/auth/me").set("Authorization", authorization).expect(200);
	});

	it("rejects wrong current passwords and malformed stored hashes without mutation", async () => {
		const authorization = `Bearer ${await createAccessToken(1, "admin", config)}`;
		for (const hash of [await hashPassword("OriginalPassword42"), "$2b$malformed"]) {
			repository.users[0].password_hash = hash;
			await request(authApp(repository)).post("/api/auth/change-password").set("Authorization", authorization)
				.send({ current_password: "wrong", new_password: "ReplacementPassword42" })
				.expect(400, { detail: "Current password is incorrect" });
			expect(repository.users[0].password_hash).toBe(hash);
			expect(repository.audits).toHaveLength(0);
		}
	});

	it("forwards account database failures to Express's generic error handler", async () => {
		repository.users[0].password_hash = await hashPassword("OriginalPassword42");
		const failure = vi.spyOn(repository, "changePassword").mockRejectedValue(new Error("test database failure"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const response = await request(authApp(repository)).post("/api/auth/change-password")
				.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
				.send({ current_password: "OriginalPassword42", new_password: "ReplacementPassword42" })
				.expect(500, { error: "Internal Server Error", message: "An unexpected error occurred." });
			expect(response.headers["set-cookie"]).toBeUndefined();
			await expect(verifyPassword("OriginalPassword42", repository.users[0].password_hash)).resolves.toBe(true);
			expect(repository.audits).toHaveLength(0);
		} finally {
			failure.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it.each([
		{}, { current_password: "original" }, { new_password: "valid-password" },
		{ current_password: 1, new_password: "valid-password" },
		{ current_password: null, new_password: "valid-password" },
		{ current_password: "original", new_password: null },
		{ current_password: "original", new_password: {} },
		{ current_password: "original", new_password: "short" },
	])("rejects invalid password-change fields: %j", async (body) => {
		await request(authApp(repository)).post("/api/auth/change-password")
			.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
			.send(body).expect(422);
		expect(repository.users[0].password_hash).toBe("not-a-valid-password-hash");
	});

	it("sets only the authenticated user's PIN and keeps refresh sessions valid", async () => {
		repository.users.push(user({ id: 2, username: "Other" }));
		await persistRefreshToken(repository, await createRefreshToken(1, config));
		const response = await request(authApp(repository)).post("/api/auth/set-pin")
			.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
			.send({ pin: "012345", user_id: 2 }).expect(200, { detail: "PIN set successfully" });
		expect(response.headers["set-cookie"]).toBeUndefined();
		expect(repository.users[0].pin_hash).not.toBe("012345");
		await expect(verifyPin("012345", repository.users[0].pin_hash!)).resolves.toBe(true);
		expect(repository.users[1].pin_hash).toBeNull();
		expect(repository.refreshTokens[0].isRevoked).toBe(false);
		expect(repository.audits).toHaveLength(0);
	});

	it.each([{}, { pin: null }, { pin: 123456 }, { pin: [] },
		{ pin: "12345" }, { pin: "1234567" }, { pin: "12345a" }, { pin: "１２３４５６" },
	])("rejects invalid PIN fields: %j", async (body) => {
		await request(authApp(repository)).post("/api/auth/set-pin")
			.set("Authorization", `Bearer ${await createAccessToken(1, "admin", config)}`)
			.send(body).expect(422);
		expect(repository.users[0].pin_hash).toBeNull();
	});
});
