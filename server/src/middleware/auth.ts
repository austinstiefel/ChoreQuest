import type { PrismaClient } from "@prisma/client";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { decodeAccessToken } from "../auth/tokens.js";
import type { AuthConfig } from "../config/auth.js";

export interface AuthenticatedUser {
	id: number;
	username: string;
	display_name: string;
	role: string;
	is_active: boolean;
}

export interface AuthUserRepository {
	findUserById(userId: number): Promise<AuthenticatedUser | null>;
}

function sendUnauthorized(res: Response, detail: string): void {
	res.status(401).json({ detail });
}

function parseUserId(subject: string): number | null {
	if (!/^\d+$/.test(subject)) return null;

	const userId = Number(subject);
	return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

/**
 * Construct a repository backed by Prisma while selecting only the current
 * account fields needed by authorization. Password and PIN hashes never need
 * to be attached to the request.
 */
export function createPrismaAuthUserRepository(prisma: PrismaClient): AuthUserRepository {
	return {
		findUserById(userId) {
			return prisma.users.findUnique({
				where: { id: userId },
				select: {
					id: true,
					username: true,
					display_name: true,
					role: true,
					is_active: true,
				},
			});
		},
	};
}

/**
 * Equivalent to Python's get_current_user dependency. The decoded role is
 * deliberately ignored: authorization always uses the current Prisma record.
 */
export function createAuthenticateRequest(
	config: AuthConfig,
	users: AuthUserRepository,
): RequestHandler {
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const authorization = req.get("Authorization");
		if (!authorization || !authorization.startsWith("Bearer ")) {
			sendUnauthorized(res, "Not authenticated");
			return;
		}

		const payload = await decodeAccessToken(authorization.slice("Bearer ".length), config);
		if (payload === null) {
			sendUnauthorized(res, "Invalid or expired token");
			return;
		}

		const userId = parseUserId(payload.sub);
		if (userId === null) {
			sendUnauthorized(res, "Invalid or expired token");
			return;
		}

		try {
			const user = await users.findUserById(userId);
			if (user === null || !user.is_active) {
				sendUnauthorized(res, "User not found or inactive");
				return;
			}

			req.authenticatedUser = user;
			next();
		} catch (error) {
			// Delegate operational failures to the established generic error
			// handler rather than returning database details to the client.
			next(error);
		}
	};
}

function authenticatedUserOrUnauthorized(req: Request, res: Response): AuthenticatedUser | null {
	if (req.authenticatedUser === undefined) {
		sendUnauthorized(res, "Not authenticated");
		return null;
	}

	return req.authenticatedUser;
}

/** Equivalent to Python's require_parent dependency. */
export const requireParent: RequestHandler = (req, res, next): void => {
	const user = authenticatedUserOrUnauthorized(req, res);
	if (user === null) return;

	if (user.role !== "parent" && user.role !== "admin") {
		res.status(403).json({ detail: "Parent or admin role required" });
		return;
	}

	next();
};

/** Equivalent to Python's require_admin dependency. */
export const requireAdmin: RequestHandler = (req, res, next): void => {
	const user = authenticatedUserOrUnauthorized(req, res);
	if (user === null) return;

	if (user.role !== "admin") {
		res.status(403).json({ detail: "Admin role required" });
		return;
	}

	next();
};
