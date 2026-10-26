import "dotenv/config";
import { loadAuthConfig } from "./config/auth.js";
import { createApp } from "./app.js";
import { prisma } from "./db/prisma.js";
import { createPrismaAuthRepository, createAuthRouter } from "./routes/auth.js";
import { createAdminRouter, createPrismaAdminRepository } from "./routes/admin.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "./auth/bootstrap.js";
import { requireDeletionSchema } from "./db/accountSchema.js";

// Validate required authentication configuration before accepting requests.
const authConfig = loadAuthConfig();
await requireDeletionSchema(prisma);
// The existing schema/baseline must already be provisioned. Bootstrap never
// creates or alters tables, and leaves installations containing users alone.
await bootstrapInitialAdmin(prisma, loadBootstrapConfig());
const authRepository = createPrismaAuthRepository(prisma);
const app = createApp(
	createAuthRouter({
		config: authConfig,
		repository: authRepository,
	}),
	authConfig,
	createAdminRouter({ config: authConfig, auth: authRepository, repository: createPrismaAdminRepository(prisma) }),
);

const port = Number(process.env.PORT ?? 3000);

const server = app.listen({ port, ...(process.env.HOST ? { host: process.env.HOST } : {}) }, () => {
	console.log(`ChoreQuest API listening on port ${port}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;

	console.log(`${signal} received; shutting down gracefully.`);

	server.close(() => {
		void prisma.$disconnect().finally(() => {
			process.exit(0);
		});
	});

	setTimeout(() => {
		console.error("Graceful shutdown timed out.");
		process.exit(1);
	}, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
