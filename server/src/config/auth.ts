const WEAK_SECRETS = new Set([
	"changeme",
	"secret",
	"password",
	"12345678",
	"1234567890123456",
]);

const DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES = 15;
const DEFAULT_REFRESH_TOKEN_EXPIRE_DAYS = 30;

export interface AuthConfig {
	secretKey: string;
	accessTokenExpireMinutes: number;
	refreshTokenExpireDays: number;
	cookieSecure: boolean;
	corsOrigins: string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

function invalidConfig(name: string): never {
	// Do not include environment values in startup errors. In particular, this
	// prevents a configured signing key from being exposed through logs.
	throw new Error(`Invalid ${name} configuration`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value)) invalidConfig(name);

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) invalidConfig(name);
	return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
	if (value === undefined) return fallback;

	switch (value.toLowerCase()) {
		case "true":
		case "1":
		case "on":
		case "yes":
		case "y":
			return true;
		case "false":
		case "0":
		case "off":
		case "no":
		case "n":
			return false;
		default:
			return invalidConfig(name);
	}
}

/**
 * Load the shared authentication settings without ever logging secret values.
 *
 * Defaults mirror the Python reference implementation. SECRET_KEY intentionally
 * has no fallback: starting without a strong signing key is rejected.
 */
export function loadAuthConfig(environment: Environment = process.env): AuthConfig {
	const secretKey = environment.SECRET_KEY;
	if (
		secretKey === undefined ||
		secretKey.length < 16 ||
		WEAK_SECRETS.has(secretKey.toLowerCase())
	) {
		return invalidConfig("SECRET_KEY");
	}

	return {
		secretKey,
		accessTokenExpireMinutes: parsePositiveInteger(
			environment.ACCESS_TOKEN_EXPIRE_MINUTES,
			DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
			"ACCESS_TOKEN_EXPIRE_MINUTES",
		),
		refreshTokenExpireDays: parsePositiveInteger(
			environment.REFRESH_TOKEN_EXPIRE_DAYS,
			DEFAULT_REFRESH_TOKEN_EXPIRE_DAYS,
			"REFRESH_TOKEN_EXPIRE_DAYS",
		),
		cookieSecure: parseBoolean(environment.COOKIE_SECURE, false, "COOKIE_SECURE"),
		corsOrigins: (environment.CORS_ORIGINS ?? "")
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
	};
}
