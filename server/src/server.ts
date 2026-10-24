import "dotenv/config";
import { loadAuthConfig } from "./config/auth.js";
import { app } from "./app.js";
import { prisma } from "./db/prisma.js";

// Validate required authentication configuration before accepting requests.
loadAuthConfig();

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
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
