import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
const destination = process.argv[2];
if (process.argv.length !== 3 || !destination || !isAbsolute(destination)) throw new Error("Supply one new absolute private environment-file path");
await writeFile(destination, `STAGING_SECRET_KEY=${randomBytes(32).toString("hex")}\nSTAGING_ADMIN_PASSWORD=${randomBytes(24).toString("hex")}\nSTAGING_PORT=8123\nSTAGING_COOKIE_SECURE=false\nSTAGING_TZ=UTC\n`, { flag: "wx", mode: 0o600 });
console.log("Private staging configuration created exclusively. Retrieve the administrator password privately; never publish this file or resolved Compose configuration.");
