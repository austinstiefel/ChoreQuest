import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { disposableDatabase } from "../helpers/sqlite.js";
import { pythonExecutable } from "../helpers/python.js";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const generator = resolve(root, "scripts/create-staging-env.mjs"), recovery = resolve(root, "scripts/snapshot-state.py");
let fixture: Awaited<ReturnType<typeof disposableDatabase>>;
beforeEach(async () => { fixture = await disposableDatabase(); await fixture.prisma.$disconnect(); });
afterEach(async () => { await fixture.dispose(); });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("creates distinct private staging credentials without printing either secret", async () => {
  const generated: string[] = [];
  for (const filename of ["one.env", "two.env"]) {
    const destination = resolve(fixture.directory, filename);
    const result = await execute(process.execPath, [generator, destination]);
    const content = await readFile(destination, "utf8");
    const key = /^STAGING_SECRET_KEY=([a-f0-9]{64})$/m.exec(content)?.[1];
    const password = /^STAGING_ADMIN_PASSWORD=([a-f0-9]{48})$/m.exec(content)?.[1];
    expect(Boolean(key && password)).toBe(true);
    for (const secret of [key!, password!]) expect((result.stdout + result.stderr).includes(secret)).toBe(false);
    expect(content.includes("STAGING_PORT=8123\n")).toBe(true);
    // Generator's loopback default is intentional; HTTPS operators must set true.
    expect(content.includes("STAGING_COOKIE_SECURE=false\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o600);
    generated.push(digest(Buffer.from(content)));
  }
  expect(generated[0] === generated[1]).toBe(false);
});
it("refuses credential overwrite and preserves the existing private file", async () => {
  const destination = resolve(fixture.directory, "existing.env");
  await execute(process.execPath, [generator, destination]);
  const before = digest(await readFile(destination));
  await expect(execute(process.execPath, [generator, destination])).rejects.toMatchObject({ code: 1 });
  expect(digest(await readFile(destination))).toBe(before);
});
it("requires an absolute credential destination in an existing parent", async () => {
  await expect(execute(process.execPath, [generator, "relative.env"], { cwd: fixture.directory })).rejects.toMatchObject({ code: 1 });
  await expect(stat(resolve(fixture.directory, "relative.env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(execute(process.execPath, [generator, resolve(fixture.directory, "missing/private.env")])).rejects.toMatchObject({ code: 1 });
});
it("requires explicit stopped-writer acknowledgement before taking a snapshot", async () => {
  const uploads = resolve(fixture.directory, "uploads"), output = resolve(fixture.directory, "snapshot");
  await mkdir(uploads);
  const before = digest(await readFile(fixture.databasePath));
  await expect(execute(pythonExecutable, ["-B", recovery, "--database", fixture.databasePath, "--uploads", uploads, "--output", output])).rejects.toMatchObject({ code: 2 });
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(digest(await readFile(fixture.databasePath))).toBe(before);
});
it("rejects a corrupted disposable source without leaving a partial snapshot", async () => {
  const uploads = resolve(fixture.directory, "uploads"), output = resolve(fixture.directory, "snapshot");
  await mkdir(uploads); await writeFile(fixture.databasePath, "synthetic-corrupt-database-marker");
  const before = digest(await readFile(fixture.databasePath));
  const result = await execute(pythonExecutable, ["-B", recovery, "--database", fixture.databasePath, "--uploads", uploads, "--output", output, "--writers-stopped"]).catch(error => error);
  expect(result.code).toBe(1);
  expect(String(result.stderr).includes("synthetic-corrupt-database-marker")).toBe(false);
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(digest(await readFile(fixture.databasePath))).toBe(before);
});
it("refuses in-place restore and preserves both the backup and occupied target", async () => {
  const uploads = resolve(fixture.directory, "uploads"), backup = resolve(fixture.directory, "snapshot"), occupied = resolve(fixture.directory, "occupied");
  await mkdir(uploads); await writeFile(resolve(uploads, "fixture.txt"), "retained");
  await execute(pythonExecutable, ["-B", recovery, "--database", fixture.databasePath, "--uploads", uploads, "--output", backup, "--writers-stopped"]);
  await mkdir(occupied); await writeFile(resolve(occupied, "keep.txt"), "retained");
  const manifest = digest(await readFile(resolve(backup, "manifest.json")));
  for (const output of [backup, occupied]) await expect(execute(pythonExecutable, ["-B", recovery, "--restore-from", backup, "--output", output])).rejects.toMatchObject({ code: 1 });
  expect(await readFile(resolve(occupied, "keep.txt"), "utf8")).toBe("retained");
  expect(digest(await readFile(resolve(backup, "manifest.json")))).toBe(manifest);
});
