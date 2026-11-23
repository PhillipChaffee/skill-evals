import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { strayskills } from "./harnesses/claude-code-strays.js";

/**
 * Makes a throwaway home, removed when the test ends.
 * @returns The home's real path.
 */
function home(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-")));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a synced skill directory reached through a symbolic link counts as a stray, for the --isolated proof", async () => {
  const root = home();
  const synced = path.join(root, ".claude", "synced");
  fs.mkdirSync(synced, { recursive: true });
  // The account's skills live outside the config directory, and the synced root links to them.
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "linked"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "linked", "SKILL.md"), "# linked\n");
  fs.symlinkSync(elsewhere, path.join(synced, "org"));
  // A skill directory whose SKILL.md is itself a link.
  const fileLinked = path.join(synced, "byfile");
  fs.mkdirSync(fileLinked);
  fs.symlinkSync(
    path.join(elsewhere, "linked", "SKILL.md"),
    path.join(fileLinked, "SKILL.md"),
  );
  // A link that leads nowhere, a loop back to the root, and a socket are not skills and do not stop the walk.
  fs.symlinkSync(path.join(root, "gone"), path.join(synced, "dangling"));
  fs.symlinkSync(synced, path.join(synced, "loop"));
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(path.join(synced, "live.sock"), resolve);
  });
  onTestFinished(() => {
    server.close();
  });
  fs.symlinkSync(path.join(synced, "live.sock"), path.join(synced, "sock"));
  expect(strayskills({ home: root, placed: undefined }).sort()).toEqual([
    "account skill byfile",
    "account skill linked",
  ]);
});

test("a placed skill reached through a link is not a stray, and a placed directory that is gone is ignored", () => {
  const root = home();
  const skills = path.join(root, ".claude", "skills");
  const real = path.join(root, "copies", "mine");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "SKILL.md"), "# mine\n");
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(real, path.join(skills, "mine"));
  const placed = { mine: real, gone: path.join(root, "gone") };
  expect(strayskills({ home: root, placed })).toEqual([]);
});
