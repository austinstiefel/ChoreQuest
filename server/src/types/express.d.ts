import type { AuthenticatedUser } from "../middleware/auth.js";

declare global {
	namespace Express {
		interface Request {
			authenticatedUser?: AuthenticatedUser;
		}
	}
}

export {};
