import {
	decodeProtectedHeader,
	jwtVerify,
	SignJWT,
	type JWTPayload,
} from "jose";
import type { AuthConfig } from "../config/auth.js";

const HS256 = "HS256";
const encoder = new TextEncoder();

export interface AccessTokenPayload {
	sub: string;
	role: string;
	exp: number;
	type: "access";
}

export interface RefreshTokenPayload {
	sub: string;
	exp: number;
	type: "refresh";
}

type BaseTokenPayload = JWTPayload & {
	sub: string;
	exp: number;
};

function signingKey(config: AuthConfig): Uint8Array {
	return encoder.encode(config.secretKey);
}

function expirationFromNow(seconds: number): number {
	// The Python implementation serializes a UTC datetime as integer epoch
	// seconds. Flooring before adding the configured duration matches it.
	return Math.floor(Date.now() / 1000) + seconds;
}

async function signToken(payload: JWTPayload, config: AuthConfig): Promise<string> {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: HS256, typ: "JWT" })
		.sign(signingKey(config));
}

/** Create an HS256 access JWT with the payload used by the Python backend. */
export function createAccessToken(
	userId: number,
	role: string,
	config: AuthConfig,
): Promise<string> {
	return signToken(
		{
			sub: String(userId),
			role,
			exp: expirationFromNow(config.accessTokenExpireMinutes * 60),
			type: "access",
		},
		config,
	);
}

/** Create an HS256 refresh JWT with the payload used by the Python backend. */
export function createRefreshToken(userId: number, config: AuthConfig): Promise<string> {
	return signToken(
		{
			sub: String(userId),
			exp: expirationFromNow(config.refreshTokenExpireDays * 86_400),
			type: "refresh",
		},
		config,
	);
}

function isBaseTokenPayload(payload: JWTPayload): payload is BaseTokenPayload {
	return typeof payload.sub === "string" && typeof payload.exp === "number" && Number.isFinite(payload.exp);
}

async function verifyToken(token: string, config: AuthConfig): Promise<BaseTokenPayload | null> {
	try {
		const header = decodeProtectedHeader(token);
		if (header.alg !== HS256) return null;

		const { payload } = await jwtVerify(token, signingKey(config), {
			algorithms: [HS256],
		});

		return isBaseTokenPayload(payload) ? payload : null;
	} catch {
		return null;
	}
}

/** Return null for invalid, expired, malformed, or non-access JWTs. */
export async function decodeAccessToken(
	token: string,
	config: AuthConfig,
): Promise<AccessTokenPayload | null> {
	const payload = await verifyToken(token, config);
	if (payload === null || payload.type !== "access" || typeof payload.role !== "string") {
		return null;
	}

	return {
		sub: payload.sub,
		role: payload.role,
		exp: payload.exp,
		type: "access",
	};
}

/** Return null for invalid, expired, malformed, or non-refresh JWTs. */
export async function decodeRefreshToken(
	token: string,
	config: AuthConfig,
): Promise<RefreshTokenPayload | null> {
	const payload = await verifyToken(token, config);
	if (payload === null || payload.type !== "refresh") return null;

	return {
		sub: payload.sub,
		exp: payload.exp,
		type: "refresh",
	};
}
