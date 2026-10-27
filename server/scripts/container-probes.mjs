// Executed by docker-smoke via node --input-type=module -e, in /app/server.
// No fixture or probe is copied into the production image. All writes are /tmp.
import assert from "node:assert/strict";
import { mkdtemp, readFile, chmod, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { Store, write } from "./dist/business/store.js";
import { insertAccount } from "./dist/auth/accounts.js";
import { initializeVapid } from "./dist/runtime/vapid.js";
import { PushService } from "./dist/runtime/push.js";
import { DailyScheduler } from "./dist/runtime/scheduler.js";
import { notify } from "./dist/business/gamification.js";
const unixPermissions = process.platform !== "win32";
if (unixPermissions) assert.notEqual(process.getuid(), 0);
assert(await bcrypt.compare("native-fixture", await bcrypt.hash("native-fixture", 4)));
await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
if (process.platform === "linux") {
  await access("/etc/ssl/certs/ca-certificates.crt");
  await access("/usr/share/zoneinfo/America/Chicago");
}
const directory = await mkdtemp(resolve(tmpdir(), "chorequest-probes-"));
const database = resolve(directory, "probe.db"), config = { subject: "mailto:probe@example.invalid" };
let db = new PrismaClient({ datasources: { db: { url: `file:${database}?connection_limit=1` } } });
try {
  const sql = await readFile("prisma/migrations/00000000000000_baseline/migration.sql", "utf8");
  for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  const userId = await db.$transaction(tx => insertAccount(tx, { username: "ProbeAdmin", displayName: "Probe", role: "admin", passwordHash: "unusable-probe" }));
  const store = await Store.open(db), keys = await initializeVapid(db, config);
  await store.insert("push_subscriptions", { user_id: userId, endpoint: "https://fcm.googleapis.com/synthetic-never-send", p256dh: "fixture", auth: "fixture" });
  let attempts = 0;
  const worker = new PushService(db, keys, config, async (_subscription, payload) => {
    attempts++; assert.equal(payload.tag, "bonus_points"); assert.equal(payload.url, "/");
    if (attempts === 1) throw { statusCode: 503 };
  });
  await write(db, store, async tx => { await notify(tx, userId, "bonus_points", "Synthetic", "Never transmitted"); await worker.prepare(tx); });
  const now = Date.now() + 1;
  await worker.processBatch(now); await worker.stop();
  const restarted = new PushService(db, keys, config, async (_subscription, payload) => { attempts++; assert.equal(payload.tag, "bonus_points"); });
  await restarted.processBatch(now + 30001); await restarted.stop();
  assert.equal(attempts, 2);
  assert.deepEqual(await db.$queryRawUnsafe("SELECT key FROM app_settings WHERE key GLOB '__runtime_push.*'"), []);
  assert.equal((await initializeVapid(db, config)).publicKey, keys.publicKey);
  const scheduler = new DailyScheduler(db, 0);
  assert.equal(await scheduler.run(), true); assert.equal(await scheduler.run(), false); await scheduler.stop();
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA foreign_key_check"), []);
  await db.$disconnect();
  // A separate connection must fail writes on an unwritable DB/directory.
  if (unixPermissions) {
    await chmod(database, 0o400); await chmod(directory, 0o500);
    db = new PrismaClient({ datasources: { db: { url: `file:${database}?connection_limit=1` } } });
    await assert.rejects(db.$executeRawUnsafe("UPDATE app_settings SET value=value"));
  }
  console.log(`PASS: compiled native modules, mocked push retry/restart, scheduler and VAPID; Unix permission probe ${unixPermissions ? "PASS" : "NOT RUN"}`);
} finally {
  await db.$disconnect();
  await chmod(directory, 0o700); await chmod(database, 0o600).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
