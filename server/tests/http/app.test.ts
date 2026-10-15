import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app.js";

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
});
