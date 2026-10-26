import { Router, type Request, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import type { AuthConfig } from "../config/auth.js";
import { createAuthenticateRequest, createPrismaAuthUserRepository, requireParent, requireAdmin, type AuthenticatedUser } from "../middleware/auth.js";
import { BusinessError, Store, write, type Row } from "./store.js";
import { validate, type Rules } from "./validation.js";
import { Download, UploadStorage } from "./uploads.js";
import { businessResponse } from "./response.js";
export type Role = "public" | "authenticated" | "parent" | "admin";
export interface Context {
	store: Store;
	user: AuthenticatedUser;
	body: Row;
	request: Request;
	file: File | null;
	onRollback: (cleanup: () => Promise<void>) => void;
	id: (key: string) => number;
	query: (rules: Rules) => Row;
}
export interface Endpoint {
	method: "get" | "post" | "put" | "delete";
	path: string;
	role: Role;
	rules?: Rules;
	status?: number;
	writes?: boolean;
	contentType?: string;
	multipart?: boolean;
	run: (context: Context) => Promise<unknown>;
}
export interface BusinessRouter {
	router: Router;
	routes: Endpoint[];
	add: (endpoint: Endpoint) => void;
}
/** Business routers use full /api paths so settings can retain parent/public-
 * feature permissions without passing through Phase 3's admin-only router. */
export async function businessRouter(prisma: PrismaClient, config: AuthConfig, uploads = new UploadStorage()): Promise<BusinessRouter> {
	const router = Router(), routes: Endpoint[] = [], store = await Store.open(prisma);
	const authenticate = createAuthenticateRequest(config, createPrismaAuthUserRepository(prisma));
	return { router, routes, add(endpoint) {
			routes.push(endpoint);
			const guards: RequestHandler[] = endpoint.role === "public" ? [] : [authenticate];
			if (endpoint.role === "parent")
				guards.push(requireParent);
			if (endpoint.role === "admin")
				guards.push(requireAdmin);
			router[endpoint.method](endpoint.path, ...guards, async (request, response, next) => {
				const cleanups: Array<() => Promise<void>> = [];
				try {
					// Consume/limit uploads before taking SQLite's writer reservation.
					const file = endpoint.multipart ? await uploads.parse(request) : null;
					const body = endpoint.rules ? validate(request.body, endpoint.rules) : {};
					const execute = (store: Store) => endpoint.run({ store, body, request, file, onRollback: fn => cleanups.push(fn), user: request.authenticatedUser!,
						id: key => Number(validate(request.params, { [key]: { type: "int" } }, "path")[key]),
						query: rules => validate(request.query, rules, "query"),
					});
					const result = (endpoint.writes ?? endpoint.method !== "get") ? await write(prisma, store, execute) : await execute(store);
					// The business transaction has committed. A response/network error
					// must not remove a proof file now referenced by a committed row.
					cleanups.length = 0;
					response.status(endpoint.status ?? 200);
					if (endpoint.status === 204)
						response.end();
					else if (result instanceof Download)
						response.sendFile(result.path);
					else if (endpoint.contentType)
						response.type(endpoint.contentType).send(result);
					else
						response.json(businessResponse(result));
				}
				catch (error) {
					const cleanupResults = await Promise.allSettled(cleanups.map(async fn => fn()));
					if (cleanupResults.some(result => result.status === "rejected")) console.warn("Business rollback cleanup failed; an unreferenced upload may require operator cleanup.");
					if (error instanceof BusinessError)
						response.status(error.status).json({ detail: error.detail });
					else
						next(error);
				}
			});
		} };
}
