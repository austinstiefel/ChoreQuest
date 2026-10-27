import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Store, write } from "../business/store.js";
import { sqliteTimestamp } from "../db/legacySqlite.js";
export interface VapidKeys {
	privateKey: string;
	publicKey: string;
}
export interface PushConfig {
	privateKey?: string;
	publicKey?: string;
	subject: string;
}
export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
	const privateKey = env.VAPID_PRIVATE_KEY || undefined, publicKey = env.VAPID_PUBLIC_KEY || undefined;
	if (Boolean(privateKey) !== Boolean(publicKey))
		throw new Error("Both VAPID key overrides must be configured together");
	const subject = env.VAPID_CLAIM_EMAIL ?? "mailto:admin@example.com";
	try {
		const url = new URL(subject);
		if (!["mailto:", "https:"].includes(url.protocol) || !url.pathname && !url.hostname)
			throw new Error();
	}
	catch {
		throw new Error("Invalid VAPID_CLAIM_EMAIL configuration");
	}
	if (privateKey && publicKey)
		keyPair(privateKey, publicKey); // sanitized errors only
	return { privateKey, publicKey, subject };
}
function loadPrivate(value: string): KeyObject {
	if (value.startsWith("-----"))
		return createPrivateKey(value);
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value))
		throw new Error();
	const raw = Buffer.from(value, "base64url");
	if (raw.length === 32) {
		const ec = createECDH("prime256v1");
		ec.setPrivateKey(raw);
		const point = ec.getPublicKey();
		return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: raw.toString("base64url"), x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
	}
	try {
		return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
	}
	catch {
		return createPrivateKey({ key: raw, format: "der", type: "sec1" });
	}
}
/** Accept Python's PEM, DER-base64url and raw scalar formats. web-push expects
 * a raw scalar, while persisted keys remain Python-readable PKCS8 PEM. */
export function keyPair(privateValue: string, expectedPublic?: string): VapidKeys {
	try {
		const key = loadPrivate(privateValue), jwk = key.export({ format: "jwk" });
		if (jwk.crv !== "P-256" || !jwk.d)
			throw new Error();
		const publicJwk = createPublicKey(key).export({ format: "jwk" });
		const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, "base64url"), Buffer.from(publicJwk.y!, "base64url")]).toString("base64url");
		if (expectedPublic !== undefined && publicKey !== expectedPublic.replace(/=+$/, ""))
			throw new Error();
		return { privateKey: jwk.d, publicKey };
	}
	catch {
		throw new Error("Invalid VAPID key configuration");
	}
}
export async function initializeVapid(prisma: PrismaClient, config: PushConfig): Promise<VapidKeys> {
	if (config.privateKey && config.publicKey)
		return keyPair(config.privateKey, config.publicKey);
	const store = await Store.open(prisma);
	return write(prisma, store, async (tx) => {
		const rows = await tx.db.$queryRaw<Array<{
			key: string;
			value: string;
		}>> `SELECT key,value FROM app_settings WHERE key IN ('vapid_private_key','vapid_public_key')`;
		const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
		if (rows.length && (!values.vapid_private_key || !values.vapid_public_key))
			console.warn("Stored VAPID pair is incomplete; replacing it. Browsers may need to resubscribe.");
		if (values.vapid_private_key && values.vapid_public_key) {
			try {
				return keyPair(values.vapid_private_key, values.vapid_public_key);
			}
			catch {
				console.warn("Stored VAPID keys are invalid; replacing the pair. Browsers may need to resubscribe.");
			}
		}
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pair = keyPair(pem);
		for (const [key, value] of [["vapid_private_key", pem], ["vapid_public_key", pair.publicKey]])
			await tx.db.$executeRaw `INSERT INTO app_settings (key,value,updated_at) VALUES (${key},${value},${sqliteTimestamp()}) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;
		return pair;
	});
}
