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
const UNSHARE = "--unshare-all";
const STORE = "/tmp/store-1";
const LOCAL_BIN = "/root/.local/bin";
const SUBJECT = "/tmp/subject-1";
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
    UNSHARE,
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
  expect(off).toContain(UNSHARE);
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

test("wrap orders the bwrap vector: / read-only, masks, what is bound back, /dev and /proc, writable, read-only, then the files that are writable", () => {
  const vector = wrap("bwrap", ["claude"], {
    writable: [WORK, HOME, TMP, STORE],
    readable: [MCP],
    appendable: [`${MCP}/calls.log`],
    masked: ["/root", "/tmp", "/run"],
    exposed: [LOCAL_BIN, SUBJECT],
    network: "off",
  });
  expect(vector).toEqual([
    ...["bwrap", "--die-with-parent", UNSHARE],
    ...["--ro-bind", "/", "/"],
    ...["--tmpfs", "/root", "--tmpfs", "/tmp", "--tmpfs", "/run"],
    ...["--ro-bind", LOCAL_BIN, LOCAL_BIN],
    ...["--ro-bind", SUBJECT, SUBJECT],
    ...["--dev", "/dev", "--proc", "/proc"],
    ...["--bind", WORK, WORK, "--bind", HOME, HOME, "--bind", TMP, TMP],
    ...["--bind", STORE, STORE],
    ...["--ro-bind", MCP, MCP],
    // The log goes in after the read-only directory around it, or the directory would cover it.
    ...["--bind", `${MCP}/calls.log`, `${MCP}/calls.log`],
    ...["--", "claude"],
  ]);
});

test("the sandbox-exec profile lets the mock log be written after it denies the directory, and allows /dev/ptmx", () => {
  const profile =
    wrap(EXEC, ["true"], {
      writable: [WORK],
      readable: [MCP],
      appendable: [`${MCP}/calls.log`],
      network: "open",
    })[2] ?? "";
  expect(profile).toContain('(literal "/dev/ptmx")');
  const denied = profile.indexOf(`(deny file-write* (subpath "${MCP}"))`);
  const allowed = profile.indexOf(
    `(allow file-write* (literal "${MCP}/calls.log"))`,
  );
  expect(denied).toBeGreaterThan(0);
  expect(allowed).toBeGreaterThan(denied);
});

test("confine hands the masks, the bound-back paths, the writable directories and the log to the vector", () => {
  const inside = confine(
    {
      backend: "bwrap",
      network: "open",
      tmp: TMP,
      masked: ["/tmp"],
      exposed: [SUBJECT],
      writable: [STORE],
      appendable: [`${MCP}/calls.log`],
    },
    { bin: "claude", args: [] },
    { workspace: WORK, home: HOME, mcp: MCP },
  );
  const at = (word: string): number => inside.args.indexOf(word);
  expect(inside.args.slice(at("--tmpfs"), at("--tmpfs") + 2)).toEqual([
    "--tmpfs",
    "/tmp",
  ]);
  expect(at("--tmpfs")).toBeLessThan(at("--dev"));
  expect(at("--dev")).toBeLessThan(at("--bind"));
  expect(inside.args).toContain(STORE);
  expect(inside.args.slice(-5, -2)).toEqual([
    "--bind",
    `${MCP}/calls.log`,
    `${MCP}/calls.log`,
  ]);
});

test("--sandbox starts the backend once, and a backend that cannot start is a usage error", () => {
  const dir = pathWith();
  fs.writeFileSync(
    path.join(dir, "bwrap"),
    "#!/bin/sh\necho 'no user namespaces' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  expect(() => requireSandbox({ PATH: dir }, "linux")).toThrow(
    /bwrap is installed but cannot start a process here/,
  );
  const works = pathWith("bwrap");
  expect(requireSandbox({ PATH: works }, "linux").backend).toBe("bwrap");
  const probe = pathWith();
  fs.writeFileSync(
    path.join(probe, "bwrap"),
    `#!/bin/sh\necho "$@" > ${probe}/args\n`,
    { mode: 0o755 },
  );
  requireSandbox({ PATH: probe }, "linux");
  expect(fs.readFileSync(path.join(probe, "args"), "utf8").trim()).toBe(
    "--ro-bind / / --tmpfs /tmp --dev /dev --proc /proc --unshare-all true",
  );
});
