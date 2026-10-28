import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
// @ts-expect-error Native ESM smoke module intentionally has no TS declaration.
import { ephemeralPortOverride } from "../../scripts/docker-smoke-ports.mjs";
// @ts-expect-error Native ESM diagnostics intentionally has no TS declaration.
import { safeDiagnostics } from "../../scripts/docker-smoke-diagnostics.mjs";

// Real Compose parsing, not mocked port/daemon metadata. Never invokes `up`,
// `run`, `build`, or a Docker daemon. CLI is also a staging/CI prerequisite.
const execute = promisify(execFile), root = fileURLToPath(new URL("../../../", import.meta.url));
const docker = process.env.CHOREQUEST_TEST_DOCKER || "docker", project = "chorequest-phase63-static";
interface Config {
  services: Record<string, {
    ports?: Array<{ host_ip: string; target: number; published?: string; protocol: string }>;
    networks?: Record<string, unknown>; network_mode?: string; container_name?: string; privileged?: boolean;
    volumes?: Array<{ type: string; source: string; target: string }>;
    read_only?: boolean; cap_drop?: string[]; security_opt?: string[]; profiles?: string[]; environment: Record<string, string>;
  }>;
  networks: Record<string, { name: string; driver: string; external?: boolean; internal?: boolean }>;
  volumes: Record<string, { name: string; external?: boolean }>;
}
let directory: string, normal: Config, smoke: Config, otherProject: Config, productionBefore: string;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "chorequest-network-static-"));
  const envFile = resolve(directory, "empty.env"), override = resolve(directory, "compose.smoke.yml");
  await writeFile(envFile, "", { mode: 0o600 });
  await writeFile(override, ephemeralPortOverride, { mode: 0o600 });
  productionBefore = digest(await readFile(resolve(root, "docker-compose.yml")));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("STAGING_")));
  Object.assign(env, { STAGING_SECRET_KEY: "phase63-static-fixture-key-only", STAGING_ADMIN_PASSWORD: "phase63-static-fixture-password-only" });
  async function parse(name: string, ephemeral = false): Promise<Config> {
    try {
      const result = await execute(docker, ["compose", "--profile", "tools", "--project-name", name, "--env-file", envFile,
        "-f", resolve(root, "server/compose.staging.yml"), ...(ephemeral ? ["-f", override] : []), "config", "--format", "json"],
      { cwd: directory, env, timeout: 15000, windowsHide: true });
      return JSON.parse(result.stdout) as Config;
    } catch (error) {
      throw new Error(`Static Compose validation failed; select the existing CLI with CHOREQUEST_TEST_DOCKER if needed. ${JSON.stringify(safeDiagnostics(error))}`);
    }
  }
  normal = await parse(project); smoke = await parse(project, true); otherProject = await parse(`${project}-other`);
}, 45000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("normal staging publishes exactly localhost 8123 to 8122/TCP", () => {
  expect(normal.services.app.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", target: 8122, published: "8123", protocol: "tcp" })]);
});
it("disposable smoke requests one localhost ephemeral mapping without adding a competing fixed port", () => {
  expect(smoke.services.app.ports).toHaveLength(1);
  expect(smoke.services.app.ports![0]).toMatchObject({ host_ip: "127.0.0.1", target: 8122, protocol: "tcp" });
  expect(smoke.services.app.ports![0]).not.toHaveProperty("published");
});
it("uses only a project-owned non-internal bridge compatible with host publication", () => {
  for (const config of [normal, smoke]) {
    expect(Object.keys(config.networks)).toEqual(["staging"]);
    expect(Object.keys(config.services.app.networks!)).toEqual(["staging"]);
    expect(config.networks.staging).toMatchObject({ driver: "bridge", name: `${project}_staging` });
    expect(config.networks.staging.internal ?? false).toBe(false);
    expect(config.networks.staging.external ?? false).toBe(false);
    expect(config.services.app.network_mode).toBeUndefined();
  }
  expect(otherProject.networks.staging.name).toBe(`${project}-other_staging`);
  expect(otherProject.networks.staging.name).not.toBe(normal.networks.staging.name);
});
it("retains private project volumes, SQLite path, hardening and provisioning isolation", () => {
  for (const config of [normal, smoke]) {
    expect(Object.keys(config.services).sort()).toEqual(["app", "provision"]);
    expect(config.services.app.container_name).toBeUndefined();
    expect(config.services.app.privileged ?? false).toBe(false);
    expect(config.services.app.read_only).toBe(true);
    expect(config.services.app.cap_drop).toContain("ALL");
    expect(config.services.app.security_opt).toContain("no-new-privileges:true");
    expect(config.services.provision.network_mode).toBe("none");
    expect(config.services.provision.profiles).toContain("tools");
    expect(config.services.app.environment.DATABASE_URL).toBe("file:/app/data/chorequest.db");
    expect(config.services.app.volumes).toEqual([
      expect.objectContaining({ type: "volume", source: "database", target: "/app/data" }),
      expect.objectContaining({ type: "volume", source: "uploads", target: "/app/data/uploads" }),
    ]);
    expect(Object.keys(config.volumes).sort()).toEqual(["database", "uploads"]);
    for (const [name, volume] of Object.entries(config.volumes)) {
      expect(volume.external ?? false).toBe(false);
      expect(volume.name).toBe(`${project}_${name}`);
    }
  }
});
it("the ephemeral override changes only app ports, without touching production Compose", async () => {
  const withoutPorts = (config: Config) => {
    const copy = structuredClone(config); delete copy.services.app.ports;
    return digest(JSON.stringify(copy)); // Never dump resolved environment values.
  };
  expect(withoutPorts(smoke)).toBe(withoutPorts(normal));
  expect(digest(await readFile(resolve(root, "docker-compose.yml")))).toBe(productionBefore);
});
