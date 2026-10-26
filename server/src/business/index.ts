import type { PrismaClient } from "@prisma/client";
import type { AuthConfig } from "../config/auth.js";
import { businessRouter } from "./router.js";
import { registerRewards } from "./rewards.js";
import { registerHousehold } from "./household.js";
import { registerChores } from "./chores.js";
import { registerCalendar } from "./calendar.js";
import { registerAvatar } from "./avatar.js";
import { registerReports } from "./reports.js";
import { registerUploads, UploadStorage } from "./uploads.js";
import { registerIntegrations, type Delivery } from "./integrations.js";
export async function createBusinessRouter(prisma: PrismaClient, config: AuthConfig, uploads = new UploadStorage(), delivery: Delivery = {}) {
	const api = await businessRouter(prisma, config, uploads);
	registerHousehold(api);
	registerRewards(api);
	registerChores(api, uploads);
	registerCalendar(api);
	registerAvatar(api);
	registerReports(api);
	registerUploads(api, uploads);
	registerIntegrations(api, delivery);
	return api;
}
