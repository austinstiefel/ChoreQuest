import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, createApp } from "../../src/app.js";
import type { AuthConfig } from "../../src/config/auth.js";

const corsConfig: AuthConfig = {
	secretKey: "test-secret-not-used-by-cors",
	accessTokenExpireMinutes: 15,
	refreshTokenExpireDays: 30,
	cookieSecure: false,
	corsOrigins: [],
};

describe("Express application", () => {
	it("returns a successful health response", async () => {
		const response = await request(app).get("/api/health");

		expect(response.status).toBe(200);
		expect(response.body).toEqual({
			status: "ok",
			service: "chorequest-api",
		});
	});

	it("returns JSON for unknown routes", async () => {
		const response = await request(app).get("/api/does-not-exist");

		expect(response.status).toBe(404);
		expect(response.body).toMatchObject({
			error: "Not Found",
		});
	});

	it("includes security headers", async () => {
		const response = await request(app).get("/api/health");

		expect(response.headers["x-powered-by"]).toBeUndefined();
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
	});

	it("allows credentialed requests only from configured CORS origins", async () => {
		const allowedOrigin = "https://app.example.test";
		const configuredApp = createApp(undefined, {
			...corsConfig,
			corsOrigins: [allowedOrigin],
		});
		const allowed = await request(configuredApp)
			.get("/api/health")
			.set("Origin", allowedOrigin)
			.expect(200);
		expect(allowed.headers["access-control-allow-origin"]).toBe(allowedOrigin);
		expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
		const preflight = await request(configuredApp)
			.options("/api/auth/login")
			.set("Origin", allowedOrigin)
			.set("Access-Control-Request-Method", "POST")
			.expect(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(allowedOrigin);
		expect(preflight.headers["access-control-allow-credentials"]).toBe("true");

		const disallowed = await request(configuredApp)
			.get("/api/health")
			.set("Origin", "https://untrusted.example.test")
			.expect(200);
		expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();
		expect(disallowed.headers["access-control-allow-credentials"]).toBeUndefined();

		const emptyOriginApp = createApp(undefined, corsConfig);
		const emptyOrigins = await request(emptyOriginApp)
			.get("/api/health")
			.set("Origin", allowedOrigin)
			.expect(200);
		expect(emptyOrigins.headers["access-control-allow-origin"]).toBeUndefined();
		expect(emptyOrigins.headers["access-control-allow-credentials"]).toBeUndefined();
	});
});
