import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { findOnPath } from "./capabilities.js";
import type { Backend, Policy } from "./os-sandbox.js";
import {
  confine,
  requireSandbox,
  sandboxBackend,
  sandboxCapability,
  wrap,
} from "./os-sandbox.js";
import { UsageError } from "./scope.js";

const WORK = "/tmp/proj-1";
const HOME = "/tmp/home-1";
const TMP = "/tmp/tmp-1";
const MCP = "/tmp/mcp-1";
const EXEC: Backend = "sandbox-exec";

/**
 * Makes a PATH directory that holds the named executables.
 * @param names - File names.
 * @returns The directory.
 */
function pathWith(...names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backends-"));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  return dir;
}

test("wrap builds the expected bwrap vector", () => {
  const policy: Policy = {
    writable: [WORK, HOME, TMP],
    readable: [],
    network: "open",
  };
  expect(wrap("bwrap", ["claude", "-p", "hi"], policy)).toEqual([
    "bwrap",
    "--die-with-parent",
    "--unshare-all",
    "--share-net",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...["--bind", WORK, WORK],
    ...["--bind", HOME, HOME],
    ...["--bind", TMP, TMP],
    "--",
    ...["claude", "-p", "hi"],
  ]);
  const off = wrap("bwrap", ["true"], { ...policy, network: "off" });
  expect(off).not.toContain("--share-net");
  expect(off).toContain("--unshare-all");
  const kept = wrap("bwrap", ["true"], { ...policy, readable: [MCP] });
  expect(kept.join(" ")).toContain("--ro-bind /tmp/mcp-1 /tmp/mcp-1 --");
});

test("wrap builds a sandbox-exec profile with the same writable set", () => {
  const policy: Policy = {
    writable: [WORK, HOME, '/tmp/a "b"'],
    readable: [MCP],
    network: "off",
  };
  const [tool, flag, profile, ...command] = wrap(EXEC, ["true"], policy);
  expect([tool, flag, command]).toEqual([EXEC, "-p", ["true"]]);
  expect(profile).toContain('(subpath "/tmp/proj-1")');
  expect(profile).toContain('(subpath "/tmp/a \\"b\\"")');
  expect(profile).toContain(`(deny file-write* (subpath "${MCP}"))`);
  expect(profile).toContain("(deny network*)");
  const open = wrap(EXEC, ["true"], {
    ...policy,
    readable: [],
    network: "open",
  });
  expect(open[2]).not.toContain("(deny network*)");
  expect(open[2]).not.toContain("(deny file-write* (subpath");
});

test("wrap refuses provider-only, which no backend can enforce", () => {
  expect(() =>
    wrap("bwrap", ["true"], {
      writable: [],
      readable: [],
      network: "provider-only",
    }),
  ).toThrow("the sandbox cannot enforce provider-only");
});

test("the backend is the executable of this platform that is on PATH", () => {
  const both = { PATH: pathWith("bwrap", EXEC) };
  expect(sandboxBackend(both, "linux")).toBe("bwrap");
  expect(sandboxBackend(both, "darwin")).toBe(EXEC);
  expect(sandboxBackend(both, "win32")).toBeNull();
  expect(sandboxBackend({ PATH: pathWith(EXEC) }, "linux")).toBeNull();
  expect(sandboxBackend({ PATH: pathWith() }, "darwin")).toBeNull();
});

test("the capability names the backend and the modes it can keep, and a missing backend is a usage error", () => {
  const env = { PATH: pathWith("bwrap", EXEC) };
  const found = sandboxCapability(env);
  expect(found?.network).toEqual(["off", "open"]);
  expect(requireSandbox(env)).toEqual(found);
  const none = { PATH: pathWith() };
  expect(sandboxCapability(none)).toBeNull();
  expect(() => requireSandbox(none)).toThrow(UsageError);
  expect(() => requireSandbox(none)).toThrow(
    "no sandbox backend found (looked for bwrap, sandbox-exec)",
  );
});

test("confine leaves a run with no sandbox alone, and gives a sandboxed one its own TMPDIR", () => {
  const command = { bin: "claude", args: ["-p", "x"] };
  const dirs = { workspace: WORK, home: HOME };
  expect(confine(undefined, command, dirs)).toEqual({ ...command, env: {} });
  const inside = confine(
    { backend: "bwrap", network: "off", tmp: TMP },
    command,
    {
      ...dirs,
      mcp: MCP,
    },
  );
  expect(inside.bin).toBe("bwrap");
  expect(inside.env).toEqual({ TMPDIR: TMP });
  expect(inside.args).toContain("--ro-bind");
  expect(inside.args.slice(-3)).toEqual(["claude", "-p", "x"]);
  const bare = confine({ backend: "bwrap", network: "open" }, command, dirs);
  expect(bare.env).toEqual({});
  expect(bare.args).not.toContain(TMP);
});

// The real thing, where it exists. A machine without bwrap, or one that forbids user namespaces, skips it.
test("a real bwrap lets the workspace be written and nothing else", (context) => {
  if (findOnPath("bwrap") === null) return context.skip();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  onTestFinished(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });
  const run = (script: string): string => {
    const [bin = "", ...args] = wrap("bwrap", ["sh", "-c", script], {
      writable: [work],
      readable: [],
      network: "off",
    });
    return execFileSync(bin, args, { encoding: "utf8" });
  };
  try {
    run("true");
  } catch {
    return context.skip();
  }
  expect(run(`echo in > ${work}/f; cat ${work}/f`)).toBe("in\n");
  expect(
    run(`(echo out > /etc/skill-evals-smoke) 2>/dev/null || echo denied`),
  ).toBe("denied\n");
});
