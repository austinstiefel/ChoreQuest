import { createHash } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, hashPin, verifyPassword } from "../../src/auth/passwords.js";
import { decodeAccessToken } from "../../src/auth/tokens.js";
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
	readonly refreshTokens: Array<{ userId: number; tokenHash: string; expiresAt: Date }> = [];

	constructor(readonly users: AuthUserRecord[]) {}

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
		this.refreshTokens.push(input);
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
});
