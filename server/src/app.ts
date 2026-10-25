import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Router } from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { healthRouter } from "./routes/health.js";

export function createApp(authRouter?: Router) {
	const app = express();

	app.disable("x-powered-by");

	app.use(helmet());
	app.use(cors());
	app.use(express.json({ limit: "1mb" }));

	app.use("/api/health", healthRouter);
	if (authRouter !== undefined) app.use("/api/auth", authRouter);

	app.use(notFoundHandler);
	app.use(errorHandler);

	return app;
}

// The bare app remains available to existing foundation tests. Production
// supplies the configured public auth router from server.ts.
export const app = createApp();
