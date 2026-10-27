// No path argument: this tool can provision only the dedicated staging mount.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const database = "/app/data/chorequest.db";
if (process.env.DATABASE_URL !== `file:${database}`) throw new Error("Invalid staging database configuration");
function run(script, args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Explicit staging provisioning failed; inspect the isolated volume before retrying");
}
// initialize-sqlite uses exclusive creation: never migrate an existing file.
run("./initialize-sqlite.mjs", [database]);
run("../node_modules/prisma/build/index.js", ["migrate", "deploy"]);
run("../node_modules/prisma/build/index.js", ["migrate", "status"]);
