import { describe, expect, it, vi } from "vitest";
import { loadAuthConfig } from "../../src/config/auth.js";

const TEST_SECRET = "phase3b-test-secret-at-least-16";

describe("authentication configuration", () => {
	it("uses the Python-compatible defaults and trims configured CORS origins", () => {
		expect(loadAuthConfig({ SECRET_KEY: TEST_SECRET })).toEqual({
			secretKey: TEST_SECRET,
			accessTokenExpireMinutes: 15,
			refreshTokenExpireDays: 30,
			cookieSecure: false,
			corsOrigins: [],
		});

		const config = loadAuthConfig({
			SECRET_KEY: TEST_SECRET,
			ACCESS_TOKEN_EXPIRE_MINUTES: "30",
			REFRESH_TOKEN_EXPIRE_DAYS: "7",
			COOKIE_SECURE: "true",
			CORS_ORIGINS: " https://one.example , ,http://two.example ",
		});
		expect(config).toMatchObject({
			accessTokenExpireMinutes: 30,
			refreshTokenExpireDays: 7,
			cookieSecure: true,
			corsOrigins: ["https://one.example", "http://two.example"],
		});
	});

	it("rejects missing, weak, and invalid values without logging or exposing secrets", () => {
		const secret = "do-not-print-this-test-signing-secret";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(() => loadAuthConfig({})).toThrow("Invalid SECRET_KEY configuration");
		expect(() => loadAuthConfig({ SECRET_KEY: "short" })).toThrow("Invalid SECRET_KEY configuration");
		expect(() => loadAuthConfig({ SECRET_KEY: "1234567890123456" })).toThrow(
			"Invalid SECRET_KEY configuration",
		);
		expect(() => loadAuthConfig({ SECRET_KEY: secret, ACCESS_TOKEN_EXPIRE_MINUTES: "0" })).toThrow(
			"Invalid ACCESS_TOKEN_EXPIRE_MINUTES configuration",
		);
		expect(() => loadAuthConfig({ SECRET_KEY: secret, REFRESH_TOKEN_EXPIRE_DAYS: "1.5" })).toThrow(
			"Invalid REFRESH_TOKEN_EXPIRE_DAYS configuration",
		);
		expect(() => loadAuthConfig({ SECRET_KEY: secret, COOKIE_SECURE: "sometimes" })).toThrow(
			"Invalid COOKIE_SECURE configuration",
		);
		expect(errorSpy).not.toHaveBeenCalled();

		try {
			loadAuthConfig({ SECRET_KEY: secret, ACCESS_TOKEN_EXPIRE_MINUTES: "invalid" });
		} catch (error) {
			expect(String(error)).not.toContain(secret);
		}
	});
});
