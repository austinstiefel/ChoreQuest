import cors from "cors";
import express from "express";
import helmet from "helmet";
import { extname, resolve } from "node:path";
import type { Router } from "express";
import type { AuthConfig } from "./config/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { healthRouter } from "./routes/health.js";

export function createApp(authRouter?: Router, authConfig?: Pick<AuthConfig, "corsOrigins"> & Partial<Pick<AuthConfig,"cookieSecure">>, adminRouter?: Router, businessRouter?: Router, staticDirectory?: string) {
	const app = express();
	const corsOrigins = authConfig?.corsOrigins ?? [];

	app.disable("x-powered-by");

	app.use(helmet({
		frameguard: { action: "deny" },
		hsts: authConfig?.cookieSecure ? { maxAge:31536000, includeSubDomains:true } : false,
		referrerPolicy: { policy: "strict-origin-when-cross-origin" },
		contentSecurityPolicy: { directives: {
			defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"], fontSrc:["'self'","https://fonts.gstatic.com"],
			imgSrc:["'self'","data:","blob:"], connectSrc:["'self'","ws:","wss:"], workerSrc:["'self'"], frameAncestors:["'none'"], upgradeInsecureRequests:null,
		} },
	}));
	app.use((_request,response,next)=>{response.set("Permissions-Policy","camera=(self), microphone=()");next();});
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
	// Settings retain their reference parent/authenticated permissions and must
	// be matched before the Phase 3 admin router's admin-only middleware.
	if (businessRouter !== undefined) app.use(businessRouter);
	if (adminRouter !== undefined) app.use("/api/admin", adminRouter);
	if (staticDirectory) {
		const directory=resolve(staticDirectory);
		app.use((request,response,next)=>{
			if (/^\/(api|ws)(\/|$)/.test(request.path)) return next();
			if (request.path==="/sw.js") response.set({"Cache-Control":"no-cache, no-store, must-revalidate",Pragma:"no-cache"});
			return express.static(directory,{index:false,dotfiles:"deny"})(request,response,next);
		});
		app.get(/.*/, (request,response,next)=>{
			if (/^\/(api|ws)(\/|$)/.test(request.path)||extname(request.path)) return next();
			response.set("Cache-Control","no-cache");response.sendFile(resolve(directory,"index.html"));
		});
	}

	app.use(notFoundHandler);
	app.use(errorHandler);

	return app;
}

// The bare app remains available to existing foundation tests. Production
// supplies the configured public auth router and CORS settings from server.ts.
export const app = createApp();
