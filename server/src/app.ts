import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Router } from "express";
import type { AuthConfig } from "./config/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { healthRouter } from "./routes/health.js";

export function createApp(authRouter?: Router, authConfig?: Pick<AuthConfig, "corsOrigins">, adminRouter?: Router) {
	const app = express();
	const corsOrigins = authConfig?.corsOrigins ?? [];

	app.disable("x-powered-by");

	app.use(helmet());
	// Match the Python service: no configured origins means no cross-origin
	// access, rather than a permissive wildcard policy. Credentials are needed
	// for the refresh-token cookie on explicitly allowed frontend origins.
	app.use(
		cors((request, callback) => {
			const requestOrigin = request.get("Origin");
			const allowed =
				requestOrigin !== undefined &&
				(corsOrigins.includes("*") || corsOrigins.includes(requestOrigin));
			callback(null, {
				origin: allowed ? requestOrigin : false,
				credentials: allowed,
				methods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
			});
		}),
	);
	app.use(express.json({ limit: "1mb", strict: false }));

	app.use("/api/health", healthRouter);
	if (authRouter !== undefined) app.use("/api/auth", authRouter);
	if (adminRouter !== undefined) app.use("/api/admin", adminRouter);

	app.use(notFoundHandler);
	app.use(errorHandler);

	return app;
}

// The bare app remains available to existing foundation tests. Production
// supplies the configured public auth router and CORS settings from server.ts.
export const app = createApp();
