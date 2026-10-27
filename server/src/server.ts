import "dotenv/config";
import { loadAuthConfig } from "./config/auth.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "./db/prisma.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "./auth/bootstrap.js";
import { requireDeletionSchema } from "./db/accountSchema.js";
import { seedBusinessData } from "./business/seed.js";
import { createRuntime } from "./runtime/index.js";
import { loadPushConfig } from "./runtime/vapid.js";
import { resetHour } from "./runtime/scheduler.js";

// Validate required authentication configuration before accepting requests.
const authConfig = loadAuthConfig();
const pushConfig = loadPushConfig(), dailyHour=resetHour();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error("Invalid PORT configuration");
await requireDeletionSchema(prisma);
// The existing schema/baseline must already be provisioned. Bootstrap never
// creates or alters tables, and leaves installations containing users alone.
await bootstrapInitialAdmin(prisma, loadBootstrapConfig());
await seedBusinessData(prisma);
const defaultStatic=fileURLToPath(new URL("../../static/",import.meta.url));
const runtime=await createRuntime(prisma,authConfig,{pushConfig,dailyHour,staticDirectory:process.env.STATIC_DIR || (existsSync(defaultStatic)?defaultStatic:undefined)});
const server = createServer(runtime.app);
server.maxConnections=512;server.requestTimeout=30_000;server.headersTimeout=15_000;
await runtime.start(server);
server.listen({ port, ...(process.env.HOST ? { host: process.env.HOST } : {}) }, () => {
	console.log(`ChoreQuest API listening on port ${port}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;

	console.log(`${signal} received; shutting down gracefully.`);

	const deadline=setTimeout(() => {
		console.error("Graceful shutdown timed out.");
		process.exit(1);
	}, 60_000);deadline.unref();
	void runtime.close(server).finally(()=>prisma.$disconnect()).then(()=>{clearTimeout(deadline);process.exitCode=0;}).catch(()=>{clearTimeout(deadline);console.error("Graceful shutdown failed");process.exitCode=1;});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
server.on("error",()=>{console.error("HTTP listener failed");shutdown("listener failure");});
