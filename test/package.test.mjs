import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const packageDir = path.resolve(import.meta.dirname, "..");

test("the packed tarball runs list from another directory", (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pack-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	fs.mkdirSync(project);
	const npm = (cwd, ...args) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const [{ filename }] = JSON.parse(npm(packageDir, "pack", "--json", "--pack-destination", root));
	npm(project, "init", "-y");
	npm(project, "install", "--no-audit", "--no-fund", "--offline", path.join(root, filename));

	const result = spawnSync(path.join(project, "node_modules/.bin/skill-evals"), ["list"], { cwd: project, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pi.*claude-code.*cursor.*opencode.*codex/s);
});
