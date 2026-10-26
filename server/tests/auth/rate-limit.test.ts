import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "../../src/routes/auth.js";

describe("Python-compatible sliding-window rate limits", () => {
	it("uses a strict cutoff, Retry-After plus one semantics, and isolated keys", () => {
		let now = 1000;
		const limiter = new SlidingWindowRateLimiter(() => now);
		expect(limiter.check("login:ip", 2, 300)).toBeUndefined();
		now += 0.5;
		expect(limiter.check("login:ip", 2, 300)).toBeUndefined();
		expect(limiter.check("login:ip", 2, 300)).toBe(300);
		expect(limiter.check("pin:ip", 1, 900)).toBeUndefined();
		now = 1300;
		expect(limiter.check("login:ip", 2, 300)).toBeUndefined();
		expect(limiter.check("login:ip", 2, 300)).toBe(1);
		now = 1300.5;
		expect(limiter.check("login:ip", 2, 300)).toBeUndefined();
	});
});
