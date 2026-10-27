import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runtimeFixture } from "../helpers/runtime.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>, directory: string;
beforeEach(async () => {
	directory = await mkdtemp(resolve(tmpdir(), "chorequest-static-test-"));
	const publicDir = resolve(directory, "public");
	await mkdir(resolve(publicDir, "assets"), { recursive: true });
	await writeFile(resolve(publicDir, "index.html"), "<!doctype html><html><body>synthetic-SPA-fixture</body></html>");
	await writeFile(resolve(publicDir, "sw.js"), "// synthetic-worker");
	await writeFile(resolve(publicDir, "assets/app.js"), "// synthetic-asset");
	await writeFile(resolve(directory, "private.txt"), "private-fixture-not-public");
	fixture = await runtimeFixture(undefined, publicDir);
});
afterEach(async () => { await fixture.dispose(); await rm(directory, { recursive: true, force: true }); });
it("serves SPA navigation/assets without swallowing unknown API paths or exposing parent directories", async () => {
	for (const path of ["/", "/chores/1", "/calendar"]) {
		const response = await fetch(fixture.base + path);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("synthetic-SPA-fixture");
	}
	expect(await (await fetch(fixture.base + "/assets/app.js")).text()).toContain("synthetic-asset");
	for (const path of ["/api/unknown", "/ws/unknown", "/assets/missing.js", "/private.txt", "/%2e%2e/private.txt"]) {
		const response = await fetch(fixture.base + path);
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("private-fixture-not-public");
	}
	expect((await fixture.http("/api/health")).status).toBe(200);
});
it("uses service-worker no-cache and Python-compatible frontend security policies", async () => {
	const sw = await fetch(fixture.base + "/sw.js");
	expect(sw.status).toBe(200);
	expect(sw.headers.get("cache-control")).toContain("no-store");
	const response = await fetch(fixture.base + "/");
	const csp = response.headers.get("content-security-policy")!;
	expect(csp).toContain("connect-src 'self' ws: wss:");
	expect(csp).toContain("worker-src 'self'");
	expect(csp).toContain("https://fonts.googleapis.com");
	expect(csp).toContain("https://fonts.gstatic.com");
	expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
	expect(response.headers.get("x-frame-options")).toBe("DENY");
});
