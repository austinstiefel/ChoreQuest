import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const sourceDatabase = resolve(repositoryRoot, "data/chores_os.db");

function sqliteUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

describe("Prisma SQLite foundation", () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let prisma: import("@prisma/client").PrismaClient;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "chorequest-prisma-"));
    databasePath = resolve(temporaryDirectory, "chores_os.db");
    await copyFile(sourceDatabase, databasePath);

    process.env.DATABASE_URL = sqliteUrl(databasePath);
    ({ prisma } = await import("../../src/db/prisma.js"));

    // The source database currently has this disabled. Enable it only on the
    // disposable copy so the target runtime's integrity behavior is tested.
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
    const foreignKeys = await prisma.$queryRaw<Array<{ foreign_keys: bigint }>>`
      PRAGMA foreign_keys
    `;
    expect(foreignKeys[0].foreign_keys).toBe(1n);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("accounts for all 28 existing tables and reads representative data", async () => {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

    expect(tables).toHaveLength(28);
    expect(tables.map(({ name }) => name)).toEqual([
      "achievements",
      "announcements",
      "api_keys",
      "app_settings",
      "audit_logs",
      "avatar_items",
      "chore_assignment_rules",
      "chore_assignments",
      "chore_categories",
      "chore_exclusions",
      "chore_rotations",
      "chores",
      "invite_codes",
      "notifications",
      "point_transactions",
      "push_subscriptions",
      "quest_templates",
      "refresh_tokens",
      "reward_redemptions",
      "rewards",
      "seasonal_events",
      "shoutouts",
      "spin_results",
      "user_achievements",
      "user_avatar_items",
      "users",
      "vacation_periods",
      "wishlist_items",
    ]);

    const users = await prisma.users.findMany({
      select: { id: true, username: true, display_name: true, role: true },
      orderBy: { id: "asc" },
    });
    expect(users.length).toBeGreaterThan(0);
    expect(users[0].id).toBe(1);

    const [chore, reward, achievement, notification, vacation, rotation] =
      await Promise.all([
        prisma.chores.findFirst({ select: { id: true, category_id: true } }),
        prisma.rewards.findFirst({ select: { id: true, created_by: true } }),
        prisma.achievements.findFirst({ select: { id: true, key: true } }),
        prisma.notifications.findFirst({ select: { id: true, user_id: true } }),
        prisma.vacation_periods.findFirst({ select: { id: true, created_by: true } }),
        prisma.chore_rotations.findFirst({ select: { id: true, chore_id: true } }),
      ]);

    expect(chore?.id).toBeTypeOf("number");
    expect(chore?.category_id).toBeTypeOf("number");
    if (reward) expect(reward.id).toBeTypeOf("number");
    if (achievement) expect(achievement.id).toBeTypeOf("number");
    if (notification) expect(notification.id).toBeTypeOf("number");
    if (vacation) expect(vacation.id).toBeTypeOf("number");
    if (rotation) expect(rotation.id).toBeTypeOf("number");
  });

  it("preserves representative foreign keys and both shoutout user relationships", async () => {
    const foreignKeys = await prisma.$queryRaw<Array<{
      table_name: string;
      from_column: string;
      to_column: string;
    }>>`
      SELECT m.name AS table_name, f."from" AS from_column, f."to" AS to_column
      FROM sqlite_master AS m
      JOIN pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table'
    `;

    const references = foreignKeys.map(({ table_name, from_column, to_column }) => `${table_name}.${from_column}->${to_column}`);
    expect(references).toEqual(expect.arrayContaining([
      "chore_assignments.chore_id->id",
      "chore_assignments.user_id->id",
      "reward_redemptions.reward_id->id",
      "reward_redemptions.user_id->id",
      "point_transactions.user_id->id",
      "user_achievements.achievement_id->id",
      "notifications.user_id->id",
      "shoutouts.from_user_id->id",
      "shoutouts.to_user_id->id",
      "vacation_periods.created_by->id",
      "chore_rotations.chore_id->id",
    ]));

    const [fromUser, toUser] = await prisma.users.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 2,
    });

    if (fromUser && toUser) {
      const shoutout = await prisma.shoutouts.create({
        data: {
          from_user_id: fromUser.id,
          to_user_id: toUser.id,
          message: "Phase 1 relationship test",
          emoji: "star",
          created_at: new Date(),
        },
        select: { id: true, from_user_id: true, to_user_id: true },
      });

      expect(shoutout.from_user_id).toBe(fromUser.id);
      expect(shoutout.to_user_id).toBe(toUser.id);
      await prisma.shoutouts.delete({ where: { id: shoutout.id } });
    }

    const foreignKeyCheck = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      PRAGMA foreign_key_check
    `;
    expect(foreignKeyCheck).toHaveLength(0);
  });

  it("round-trips a safe record and JSON text through Prisma", async () => {
    const key = `phase1_test_${Date.now()}`;
    const created = await prisma.app_settings.create({
      data: { key, value: "before", updated_at: new Date() },
    });

    try {
      await prisma.app_settings.update({
        where: { key },
        data: { value: "after", updated_at: new Date() },
      });
      const updated = await prisma.app_settings.findUnique({ where: { key } });
      expect(updated?.key).toBe(created.key);
      expect(updated?.value).toBe("after");

      await expect(
        prisma.app_settings.create({
          data: { key, value: "duplicate", updated_at: new Date() },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      const achievement = await prisma.$queryRaw<Array<{ criteria: string }>>`
        SELECT criteria FROM achievements ORDER BY id LIMIT 1
      `;
      expect(JSON.parse(achievement[0].criteria)).toEqual(expect.any(Object));

      const chore = await prisma.chores.findFirst({ select: { id: true } });
      if (chore) {
        await prisma.$executeRaw`
          INSERT INTO chore_rotations
            (chore_id, kid_ids, cadence, current_index, created_at, updated_at)
          VALUES
            (${chore.id}, ${JSON.stringify([1, 2])}, ${"weekly"}, ${0}, ${new Date().toISOString()}, ${new Date().toISOString()})
        `;

        const rotation = await prisma.$queryRaw<Array<{ id: number; kid_ids: string }>>`
          SELECT id, kid_ids FROM chore_rotations
          WHERE chore_id = ${chore.id}
          ORDER BY id DESC LIMIT 1
        `;
        expect(JSON.parse(rotation[0].kid_ids)).toEqual([1, 2]);
        await prisma.$executeRaw`DELETE FROM chore_rotations WHERE id = ${rotation[0].id}`;
      }
    } finally {
      await prisma.app_settings.delete({ where: { key } });
    }
  });
});
