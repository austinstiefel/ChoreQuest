import type { PrismaClient } from "@prisma/client";
import type { Server } from "node:http";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AuthConfig } from "../config/auth.js";
import { createApp } from "../app.js";
import { createAuthRouter, createPrismaAuthRepository } from "../routes/auth.js";
import { createAdminRouter, createPrismaAdminRepository } from "../routes/admin.js";
import { createBusinessRouter } from "../business/index.js";
import { UploadStorage } from "../business/uploads.js";
import { createPrismaAuthUserRepository } from "../middleware/auth.js";
import { SocketHub } from "./websocket.js";
import { initializeVapid, loadPushConfig, type PushConfig } from "./vapid.js";
import { PushService, type PushSender } from "./push.js";
import { DailyScheduler, resetHour } from "./scheduler.js";
export interface RuntimeOptions {
	uploads?: UploadStorage;
	pushConfig?: PushConfig;
	sender?: PushSender;
	dailyHour?: number;
	staticDirectory?: string;
}
/** Caller owns schema checks/bootstrap/catalogue initialization. This factory
 * never opens an implicit/default database and is directly integration-testable. */
export async function createRuntime(prisma: PrismaClient, config: AuthConfig, options: RuntimeOptions = {}) {
	const pushConfig = options.pushConfig ?? loadPushConfig(), hour = options.dailyHour ?? resetHour();
	if (options.staticDirectory && !(await stat(resolve(options.staticDirectory, "index.html"))).isFile())
		throw new Error("STATIC_DIR must contain a built frontend index.html");
	const keys = await initializeVapid(prisma, pushConfig), auth = createPrismaAuthRepository(prisma);
	const hub = new SocketHub(config, createPrismaAuthUserRepository(prisma)), push = new PushService(prisma, keys, pushConfig, options.sender), scheduler = new DailyScheduler(prisma, hour);
	const business = await createBusinessRouter(prisma, config, options.uploads, { prepare: store => push.prepare(store), publish: events => hub.publish(events), emote: event => hub.publish([{ message: { type: "emote", data: event } }]), testPush: user => push.test(user), vapidPublicKey: async () => keys.publicKey });
	const app = createApp(createAuthRouter({ config, repository: auth, profileChanged: user => hub.publish([{ excludeUser: user, message: { type: "data_changed", data: { entity: "user" } } }]) }), config, createAdminRouter({ config, auth, repository: createPrismaAdminRepository(prisma) }), business.router, options.staticDirectory);
	let timer: NodeJS.Timeout | undefined, stopping: Promise<void> | undefined;
	return { app, hub, push, scheduler, business, keys,
		async start(server: Server, background = true) {
			// Reconciliation errors fail startup before listening. The checkpoint
			// prevents duplicate execution across restarts and separate processes.
			await scheduler.run(new Date(), true);
			hub.attach(server);
			if (background) {
				scheduler.start();
				timer = setInterval(() => push.kick(), 1000);
				timer.unref();
				push.kick();
			}
		},
		close(server: Server): Promise<void> {
			return stopping ??= (async () => {
				clearInterval(timer);
				const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
				server.closeIdleConnections();
				// Stop new push attempts immediately: waiting for HTTP first would
				// let a long multi-device test request delay shutdown indefinitely.
				// In-flight business requests may still persist jobs for next startup.
				const results = await Promise.allSettled([hub.close(), scheduler.stop(), push.stop(), httpClosed]);
				if (results.some(result => result.status === "rejected"))
					throw new Error("Runtime shutdown failed");
			})();
		},
	};
}
