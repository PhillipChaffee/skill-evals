import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { lockDir, requireUnlocked, startTimeOf } from "./lock.js";
import { UsageError } from "./scope.js";
import { sandbox } from "./testing/sandbox.js";

const BOOT_FILE = "/proc/sys/kernel/random/boot_id";
const bootNow = fs.existsSync(BOOT_FILE)
  ? fs.readFileSync(BOOT_FILE, "utf8").trim()
  : null;

/**
 * Makes a directory to lock.
 * @returns The directory and the path of its lock file.
 */
function dir() {
  const box = sandbox();
  const out = path.join(box.root, "out");
  fs.mkdirSync(out);
  return { out, file: path.join(out, ".lock") };
}

/**
 * Starts a process that stays alive until the test ends.
 * @returns Its pid.
 */
function sleeper(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  return child.pid as number;
}

/**
 * Writes a lock as another command would have.
 * @param file - Where the lock goes: the `.lock` of an output directory.
 * @param holder - Fields that replace the ones that describe this process.
 */
function writeLock(file: string, holder: Record<string, unknown>): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      bootId: bootNow,
      startTime: startTimeOf(process.pid),
      ...holder,
    }),
  );
}

const quiet = () =>
  vi.spyOn(console, "error").mockImplementation(() => undefined);

test("a lock names the process, host, boot and start time, and is removed when released", () => {
  const { out, file } = dir();
  const release = lockDir(out);
  const text = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  expect(text).toMatchObject({
    pid: process.pid,
    hostname: os.hostname(),
    bootId: bootNow,
  });
  expect(text["startTime"]).toBe(startTimeOf(process.pid));
  release();
  expect(fs.existsSync(file)).toBe(false);
  release();
});

test("a second lock on a directory that this process holds is refused, naming the file", () => {
  const { out, file } = dir();
  const release = lockDir(out);
  expect(() => lockDir(out)).toThrow(UsageError);
  expect(() => lockDir(out)).toThrow(
    new RegExp(`${file}: process ${String(process.pid)} on .* is using`),
  );
  expect(() => {
    requireUnlocked(out);
  }).toThrow(/\.lock/);
  release();
  requireUnlocked(out);
});

test("a lock that names this process but is not held in memory is stale, whatever its start time", () => {
  const { out, file } = dir();
  const warn = quiet();
  try {
    // A pid of 5 in a namespace that was killed looks like this one: same pid, and another process.
    writeLock(file, { startTime: "1" });
    lockDir(out)();
    writeLock(file, {});
    requireUnlocked(out);
    lockDir(out)();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`took over ${file}`);
  } finally {
    warn.mockRestore();
  }
});

test("another live process is a holder only while its start time matches", () => {
  const { out, file } = dir();
  const pid = sleeper();
  const startTime = startTimeOf(pid);
  expect(startTime).not.toBeNull();
  writeLock(file, { pid, startTime });
  expect(() => lockDir(out)).toThrow(
    new RegExp(`process ${String(pid)} on .* is using`),
  );
  expect(() => {
    requireUnlocked(out);
  }).toThrow(UsageError);
  const warn = quiet();
  try {
    // The pid was reused by a later process.
    writeLock(file, { pid, startTime: "1" });
    lockDir(out)();
    // Where /proc says nothing, the pid alone decides.
    writeLock(file, { pid, startTime: null });
    expect(() => lockDir(out)).toThrow(UsageError);
  } finally {
    warn.mockRestore();
  }
});

test("a lock of a process that is gone is taken over, and so is text that is no lock", () => {
  const { out, file } = dir();
  const warn = quiet();
  try {
    writeLock(file, { pid: 2_147_483_646 });
    lockDir(out)();
    for (const text of [
      "garbage",
      "null",
      "5",
      '{"pid": 1}',
      ...[0, -1, 1.5].map((pid) =>
        JSON.stringify({ pid, hostname: os.hostname() }),
      ),
    ]) {
      fs.writeFileSync(file, text);
      lockDir(out)();
    }
    expect(warn).toHaveBeenCalledTimes(8);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(
      "which was not a lock",
    );
  } finally {
    warn.mockRestore();
  }
});

test("a lock from another host or boot is refused, naming the file, the host and the pid", () => {
  const { out, file } = dir();
  writeLock(file, { hostname: "elsewhere", pid: 77 });
  const refused = (): string => {
    try {
      lockDir(out);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  const message = refused();
  expect(message).toContain(file);
  expect(message).toContain("process 77 on host elsewhere");
  expect(message).toContain(`remove ${file} if no command is using`);
  expect(() => {
    requireUnlocked(out);
  }).toThrow(/elsewhere/);
  for (const boot of bootNow === null ? [] : ["another-boot"]) {
    writeLock(file, { bootId: boot, pid: 78 });
    expect(refused()).toContain("process 78 on host");
  }
});

test("two takeovers of one stale lock end with exactly one winner", () => {
  const { out, file } = dir();
  writeLock(file, { pid: 2_147_483_646 });
  const warn = quiet();
  const outcomes: string[] = [];
  try {
    for (let command = 0; command < 2; command++) {
      try {
        lockDir(out);
        outcomes.push("won");
      } catch (error) {
        outcomes.push(error instanceof UsageError ? "refused" : "crashed");
      }
    }
  } finally {
    warn.mockRestore();
  }
  expect(outcomes).toEqual(["won", "refused"]);
});

test("a takeover that another command has under way is not joined", () => {
  const { out, file } = dir();
  writeLock(file, { pid: 2_147_483_646 });
  fs.writeFileSync(path.join(out, ".lock.takeover"), "");
  expect(() => lockDir(out)).toThrow(/taking it over.*\.lock\.takeover/);
  // The lock it did not touch is still the stale one.
  expect(fs.existsSync(file)).toBe(true);
});

test("a lock that the holder released between the failed create and the read is created again", () => {
  const { out, file } = dir();
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("exists"), { code: "EEXIST" });
  });
  try {
    lockDir(out)();
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(file)).toBe(false);
});

test("a lock that cannot be created for another reason is an error, not a refusal", () => {
  const { out } = dir();
  expect(() => lockDir(path.join(out, "missing"))).toThrow(/ENOENT/);
});

test("the start time of a process that does not exist is unknown", () => {
  expect(startTimeOf(2_147_483_646)).toBeNull();
  expect(startTimeOf(process.pid)).toMatch(/^\d+$/);
});
