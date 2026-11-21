import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A wrong command line, case file, or environment: reported without a stack trace, exit code 2. */
export class UsageError extends Error {}

const live = new Set();
process.on("exit", () => {
	for (const dispose of [...live]) dispose();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

/** Registers a cleanup that runs once: when the returned function is called, or when the process exits. */
export function onDispose(cleanup) {
	const dispose = () => {
		if (live.delete(dispose)) cleanup();
	};
	live.add(dispose);
	return dispose;
}

/** A temp directory whose name gives the agent no hint about why it exists. */
export function tempDir(prefix) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	return { dir, dispose: onDispose(() => fs.rmSync(dir, { recursive: true, force: true })) };
}
