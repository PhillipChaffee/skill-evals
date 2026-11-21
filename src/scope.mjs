import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A wrong command line, case file, or environment: reported without a stack trace, exit code 2. */
export class UsageError extends Error {
	name = "UsageError";
}

export function requireSupportedPlatform() {
	if (process.platform === "win32") throw new UsageError("Windows is not supported; use macOS, Linux, or WSL");
}

const live = new Set();
process.on("exit", () => {
	for (const dispose of [...live]) dispose();
});
const SIGNALS = ["SIGINT", "SIGTERM"];
const interrupted = () => process.exit(130);

/**
 * Registers a cleanup that runs once: when the returned function is called, or when the process exits.
 * A signal ends the process only while a cleanup is registered, so a program that imports this keeps its own
 * signal handling the rest of the time.
 */
export function onDispose(cleanup) {
	const dispose = () => {
		if (!live.delete(dispose)) return;
		if (live.size === 0) for (const signal of SIGNALS) process.off(signal, interrupted);
		cleanup();
	};
	if (live.size === 0) for (const signal of SIGNALS) process.on(signal, interrupted);
	live.add(dispose);
	return dispose;
}

/** Where a command's results go: the requested directory, created when missing, or a new temp directory that stays. */
export function outputDir(requested, cwd) {
	if (!requested) return fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
	const dir = path.resolve(cwd, requested);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** A temp directory whose name gives the agent no hint about why it exists. */
export function tempDir(prefix) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	return { dir, dispose: onDispose(() => fs.rmSync(dir, { recursive: true, force: true })) };
}
