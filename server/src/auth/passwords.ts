import bcrypt from "bcrypt";

// Python's bcrypt.gensalt() uses 12 rounds by default. Keep newly-created
// Node hashes aligned while bcrypt.compare remains compatible with all valid
// existing bcrypt hashes, including the Python-generated rows in SQLite.
const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
	try {
		return await bcrypt.compare(password, passwordHash);
	} catch {
		// A corrupt legacy database row is an invalid credential, not an
		// operational error to expose through the login endpoint.
		return false;
	}
}

export function hashPin(pin: string): Promise<string> {
	return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export function verifyPin(pin: string, pinHash: string): Promise<boolean> {
	return verifyPassword(pin, pinHash);
}
