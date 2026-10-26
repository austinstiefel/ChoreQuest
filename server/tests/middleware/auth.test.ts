import express, { type RequestHandler } from "express";
import request from "supertest";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccessToken, createRefreshToken } from "../../src/auth/tokens.js";
import type { AuthConfig } from "../../src/config/auth.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import {
	createAuthenticateRequest,
	requireAdmin,
	requireParent,
	requireKid,
	type AuthenticatedUser,
	type AuthUserRepository,
} from "../../src/middleware/auth.js";

const TEST_SECRET = "phase3c-test-secret-at-least-16";
const config: AuthConfig = {
	secretKey: TEST_SECRET,
	accessTokenExpireMinutes: 15,
	refreshTokenExpireDays: 30,
	cookieSecure: false,
	corsOrigins: [],
};
const encoder = new TextEncoder();

function user(role: string, isActive = true): AuthenticatedUser {
	return {
		id: 42,
		username: "current-user",
		display_name: "Current User",
		role,
		is_active: isActive,
	};
}

function repository(result: AuthenticatedUser | null | Error): AuthUserRepository {
	return {
		findUserById: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		}),
	};
}

function protectedApp(users: AuthUserRepository, ...authorization: RequestHandler[]) {
	const app = express();
	app.get(
		"/protected",
		createAuthenticateRequest(config, users),
		...authorization,
		(req, res) => {
			res.json({
				id: req.authenticatedUser?.id,
				role: req.authenticatedUser?.role,
			});
		},
	);
	app.use(errorHandler);
	return app;
}

async function accessToken(role = "kid"): Promise<string> {
	return createAccessToken(42, role, config);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("database-backed authentication middleware", () => {
	it("rejects missing and malformed bearer headers with the Python-compatible response", async () => {
		const app = protectedApp(repository(user("kid")));

		await request(app).get("/protected").expect(401, { detail: "Not authenticated" });
		await request(app)
			.get("/protected")
			.set("Authorization", "Basic anything")
			.expect(401, { detail: "Not authenticated" });
		await request(app)
			.get("/protected")
			.set("Authorization", "Bearer")
			.expect(401, { detail: "Not authenticated" });
	});

	it("rejects invalid, expired, refresh, and bad-signature tokens", async () => {
		const app = protectedApp(repository(user("kid")));
		const refreshToken = await createRefreshToken(42, config);
		const expiredToken = await new SignJWT({ role: "kid", type: "access", exp: 1 })
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setSubject("42")
			.sign(encoder.encode(TEST_SECRET));
		const signedWithOtherKey = await createAccessToken(42, "kid", {
			...config,
			secretKey: "other-phase3c-test-secret",
		});

		for (const token of ["not-a-token", expiredToken, refreshToken, signedWithOtherKey]) {
			await request(app)
				.get("/protected")
				.set("Authorization", `Bearer ${token}`)
				.expect(401, { detail: "Invalid or expired token" });
		}
	});

	it("attaches the active database user and ignores the token's role claim", async () => {
		const users = repository(user("admin"));
		const app = protectedApp(users);

		await request(app)
			.get("/protected")
			.set("Authorization", `Bearer ${await accessToken("kid")}`)
			.expect(200, { id: 42, role: "admin" });
		expect(users.findUserById).toHaveBeenCalledWith(42);
	});

	it("rejects deleted and inactive database users", async () => {
		for (const users of [repository(null), repository(user("kid", false))]) {
			await request(protectedApp(users))
				.get("/protected")
				.set("Authorization", `Bearer ${await accessToken()}`)
				.expect(401, { detail: "User not found or inactive" });
		}
	});

	it("passes database errors to the generic error handler without exposing details", async () => {
		const internalMessage = "database connection credentials and stack trace";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await request(protectedApp(repository(new Error(internalMessage))))
			.get("/protected")
			.set("Authorization", `Bearer ${await accessToken()}`)
			.expect(500);

		expect(response.body).toEqual({
			error: "Internal Server Error",
			message: "An unexpected error occurred.",
		});
		expect(JSON.stringify(response.body)).not.toContain(internalMessage);
		expect(errorSpy).toHaveBeenCalled();
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(internalMessage);
	});
});

describe("role authorization middleware", () => {
	it.each(["kid", "parent", "admin"])("matches Python requireKid for %s", async (role) => {
		const response = await request(protectedApp(repository(user(role)), requireKid))
			.get("/protected").set("Authorization", `Bearer ${await accessToken("admin")}`);
		expect(response.status).toBe(role === "kid" ? 200 : 403);
		if (role !== "kid") expect(response.body).toEqual({ detail: "Kid role required" });
	});
	it.each(["parent", "admin"])("permits %s through requireParent", async (role) => {
		await request(protectedApp(repository(user(role)), requireParent))
			.get("/protected")
			.set("Authorization", `Bearer ${await accessToken()}`)
			.expect(200, { id: 42, role });
	});

	it("rejects a kid from requireParent", async () => {
		await request(protectedApp(repository(user("kid")), requireParent))
			.get("/protected")
			.set("Authorization", `Bearer ${await accessToken()}`)
			.expect(403, { detail: "Parent or admin role required" });
	});

	it("permits an admin and rejects parent and kid from requireAdmin", async () => {
		await request(protectedApp(repository(user("admin")), requireAdmin))
			.get("/protected")
			.set("Authorization", `Bearer ${await accessToken()}`)
			.expect(200, { id: 42, role: "admin" });

		for (const role of ["parent", "kid"]) {
			await request(protectedApp(repository(user(role)), requireAdmin))
				.get("/protected")
				.set("Authorization", `Bearer ${await accessToken()}`)
				.expect(403, { detail: "Admin role required" });
		}
	});
});
