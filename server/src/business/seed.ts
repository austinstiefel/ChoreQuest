import { Prisma, type PrismaClient } from "@prisma/client";
import { Store, write } from "./store.js";
import { sqliteTimestamp } from "../db/legacySqlite.js";
import { seedCatalogue as catalogue } from "./seedCatalogue.js";
/** Reference built-in catalogue initialization, serialized and idempotent.
 * Never overwrites passwords, user customizations, achievement rewards or
 * existing schedules. The Python startup's destructive legacy rule cleanup
 * is intentionally not performed by this runtime initializer. */
export async function seedBusinessData(prisma: PrismaClient) {
	const store = await Store.open(prisma);
	await write(prisma, store, async (tx) => {
		if (!(await tx.rows("chore_categories", Prisma.sql `LIMIT 1`)).length)
			for (const category of catalogue.DEFAULT_CATEGORIES)
				await tx.insert("chore_categories", { ...category, is_default: true });
		const keys = new Set((await tx.rows("achievements")).map(a => a.key));
		for (const achievement of catalogue.DEFAULT_ACHIEVEMENTS)
			if (!keys.has(achievement.key))
				await tx.insert("achievements", { tier: null, group_key: null, ...achievement });
		const settings = new Set((await tx.rows("app_settings")).map(s => s.key));
		for (const [key, value] of Object.entries(catalogue.DEFAULT_SETTINGS))
			if (!settings.has(key))
				await tx.db.$executeRaw `INSERT INTO app_settings (key,value,updated_at) VALUES (${key},${typeof value === "string" ? value : JSON.stringify(value)},${sqliteTimestamp()})`;
		const creator = (await tx.rows("users", Prisma.sql `WHERE role IN ('admin','parent') ORDER BY id LIMIT 1`))[0];
		if (creator) {
			const categories = new Map((await tx.rows("chore_categories")).map(c => [c.name, c.id])), titles = new Set((await tx.rows("chores")).map(c => c.title));
			for (const quest of catalogue.DEFAULT_QUESTS)
				if (!titles.has(quest.title) && categories.has(quest.category)) {
					const { category, ...values } = quest;
					await tx.insert("chores", { ...values, category_id: categories.get(category), custom_days: null, requires_photo: false, is_active: true, created_by: creator.id });
				}
		}
		if (!(await tx.rows("quest_templates", Prisma.sql `LIMIT 1`)).length)
			for (const template of catalogue.QUEST_TEMPLATES)
				await tx.insert("quest_templates", template);
		if (!(await tx.rows("avatar_items", Prisma.sql `LIMIT 1`)).length)
			for (const [category, item_id, display_name, rarity, unlock_method, unlock_value, is_default] of catalogue.DEFAULT_AVATAR_ITEMS)
				await tx.insert("avatar_items", { category, item_id, display_name, rarity, unlock_method, unlock_value, is_default });
	});
}
