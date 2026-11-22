import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { maskingOf } from "./sandbox-masks.js";

const EXECUTABLE = 0o755;
const LOCAL = ".local/bin";
const SUBJECT_DIR = "proj/subject";
const ELSEWHERE = "elsewhere/cases";
const NO_TOOL = "no-such-tool";
const GONE = "/nonexistent";

/**
 * Lays out an operator's machine outside the temp directories, which are always hidden: a home with a harness installed
 * as an npm package, a project that holds its cases and its output, and cases elsewhere.
 * @returns The paths.
 */
function machine() {
  const root = fs.realpathSync(fs.mkdtempSync("/var/tmp/masks-"));
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const at = (...parts: string[]): string => path.join(root, ...parts);
  const make = (file: string, text = ""): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: EXECUTABLE });
    return file;
  };
  const home = at("home");
  const scoped = make(
    path.join(home, ".local/lib/node_modules/@scope/pkg/bin/run.js"),
  );
  fs.mkdirSync(path.join(home, LOCAL), { recursive: true });
  fs.symlinkSync(scoped, path.join(home, ".local/bin/tool"));
  const plain = make(path.join(home, ".local/lib/node_modules/plain/cli.js"));
  fs.symlinkSync(plain, path.join(home, ".local/bin/plain"));
  make(at("proj/cases/a/case.json"));
  fs.mkdirSync(at("proj/out"));
  fs.mkdirSync(at(SUBJECT_DIR));
  fs.mkdirSync(at(ELSEWHERE), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", `${path.join(home, LOCAL)}:/usr/bin`);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  return { root, at, home };
}

test("the sandbox hides the home, the temp directories, /run, the cases, the output and the project, outermost only", () => {
  const box = machine();
  const { masked } = maskingOf({
    casesDir: box.at(ELSEWHERE),
    outDir: box.at("proj/out"),
    projectRoot: box.at("proj"),
    bin: "tool",
  });
  expect(masked).toContain(box.home);
  expect(masked).toContain(box.at("proj"));
  expect(masked).toContain(box.at(ELSEWHERE));
  expect(masked).toContain("/tmp");
  // The output directory is inside the project, which is already hidden; and `/` is never hidden.
  expect(masked).not.toContain(box.at("proj/out"));
  expect(masked).not.toContain("/");
  expect(new Set(masked).size).toBe(masked.length);
});

test("what the harness needs is bound back: its package, its directory on PATH, and the subject, but only inside a hidden directory", () => {
  const box = machine();
  const { exposed } = maskingOf({
    outDir: box.at("proj/out"),
    projectRoot: box.at("proj"),
    bin: "tool",
    subjectDir: box.at(SUBJECT_DIR),
  });
  expect(exposed).toContain(
    path.join(box.home, ".local/lib/node_modules/@scope/pkg"),
  );
  expect(exposed).toContain(path.join(box.home, LOCAL));
  expect(exposed).toContain(box.at(SUBJECT_DIR));
  expect(exposed).not.toContain("/usr/bin");
  // An unscoped package is bound whole, and so is a plain executable's directory.
  expect(
    maskingOf({ outDir: box.at("proj/out"), bin: "plain" }).exposed,
  ).toContain(path.join(box.home, ".local/lib/node_modules/plain"));
  const absolute = path.join(box.home, ".local/bin/plain");
  expect(
    maskingOf({ outDir: box.at("proj/out"), bin: absolute }).exposed,
  ).toContain(path.join(box.home, ".local/lib/node_modules/plain"));
  expect(maskingOf({ outDir: GONE, bin: NO_TOOL }).exposed).not.toContain(
    path.join(box.home, ".local/lib"),
  );
  const loose = path.join(box.home, "bin/loose");
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, "", { mode: EXECUTABLE });
  expect(maskingOf({ outDir: GONE, bin: loose }).exposed).toContain(
    path.dirname(loose),
  );
  const dangling = path.join(box.home, "bin/dangling");
  fs.symlinkSync(box.at("gone"), dangling);
  expect(maskingOf({ outDir: GONE, bin: dangling }).exposed).not.toContain(
    box.at("gone"),
  );
});

test("the resolver's directory is bound back when resolv.conf points into it", () => {
  const box = machine();
  const dir = path.join(box.home, "resolve");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "stub"), "");
  fs.mkdirSync(box.at("etc"));
  fs.symlinkSync(path.join(dir, "stub"), box.at("etc/resolv.conf"));
  const dns = { conf: box.at("etc/resolv.conf"), dir };
  expect(maskingOf({ outDir: GONE, bin: "tool", dns }).exposed).toContain(dir);
  const plain = { conf: box.at("etc/none"), dir };
  expect(
    maskingOf({ outDir: GONE, bin: "tool", dns: plain }).exposed,
  ).not.toContain(dir);
});
