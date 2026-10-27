import { fileURLToPath } from "node:url";

// Local checks use the existing repository environment. Linux CI explicitly
// selects setup-python's interpreter; never silently select another Python.
export const pythonExecutable = process.env.CHOREQUEST_TEST_PYTHON || fileURLToPath(
	new URL(process.platform === "win32" ? "../../../.venv/Scripts/python.exe" : "../../../.venv/bin/python", import.meta.url),
);
