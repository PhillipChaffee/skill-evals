import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { childEnv } from "./env.js";
import { CONFIG_FILE } from "./project.js";
import { plantCase, script, skillsFolder } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";

const USAGE_ERROR = 2;
const NONE = { harnessEnv: {}, authEnv: [], pass: [], withhold: [] };

/**
 * Scores one case whose agent runs `env`, and reads what the harness process received.
 * @param extra - Environment variables of the command line, and the keys of the project's config file.
 * @param extra.env - Variables set in the command line's environment.
 * @param extra.config - The project's config file.
 * @returns The names of the variables that the agent's command saw.
 */
async function seenNames(extra: {
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}): Promise<string[]> {
  const box = sandbox();
  script(box, "env", {
    turns: [
      [{ call: { name: "Bash", input: { command: "env" }, exec: true } }],
    ],
  });
  if (extra.config) box.write(CONFIG_FILE, extra.config);
  const cases = plantCase(box, [{ type: "output_contains", text: "x" }]);
  const outDir = path.join(box.root, "results");
  const result = await box.cli(
    [
      "score",
      "--subject",
      skillsFolder(box, "skills", { bro: "# bro\n" }),
      "--cases",
      cases,
      "--reps",
      "1",
      "--out",
      outDir,
    ],
    extra.env,
  );
  expect(result.status, result.stderr).toBe(0);
  const stream = fs.readFileSync(
    path.join(outDir, "claude-code/restate/subject1.stream.jsonl"),
    "utf8",
  );
  const output = stream
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; message?: unknown })
    .filter((event) => event.type === "user")
    .map((event) => JSON.stringify(event.message))
    .join("\n");
  return [...output.matchAll(/(?:\\n|^|")([A-Za-z_][A-Za-z0-9_]*)=/g)].map(
    (match) => match[1] ?? "",
  );
}

test("a variable outside the allowlist does not reach the harness", async () => {
  const names = await seenNames({ env: { SECRET_THING: "1" } });
  expect(names).toContain("HOME");
  expect(names).toContain("PATH");
  expect(names).not.toContain("SECRET_THING");
});

test("a name in config env passes", async () => {
  const names = await seenNames({
    env: { SECRET_THING: "1", OTHER_THING: "2" },
    config: { env: ["SECRET_THING"] },
  });
  expect(names).toContain("SECRET_THING");
  expect(names).not.toContain("OTHER_THING");
});

test("a name in config env that names this tool is a config error", async () => {
  for (const name of ["SKILL_EVALS_X", "npm_config_y"]) {
    const box = sandbox();
    box.write(CONFIG_FILE, { env: [name] });
    const result = await box.cli(["list"]);
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toContain(`"env"`);
    expect(result.stderr).toContain(name);
  }
});

test("config env must be a list of strings", async () => {
  for (const value of ["HOME", [1], {}]) {
    const box = sandbox();
    box.write(CONFIG_FILE, { env: value });
    const result = await box.cli(["list"]);
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toContain('"env" must be a list of strings');
  }
});

test("the allowlisted names pass and nothing else does", () => {
  const base = {
    PATH: "/bin",
    SHELL: "sh",
    USER: "u",
    LOGNAME: "u",
    TMPDIR: "/t",
    TERM: "x",
    TZ: "UTC",
    LANG: "C",
    LANGUAGE: "en",
    LC_ALL: "C",
    LC_CTYPE: "C",
    SSL_CERT_FILE: "a",
    SSL_CERT_DIR: "b",
    NODE_EXTRA_CA_CERTS: "c",
    REQUESTS_CA_BUNDLE: "d",
    CURL_CA_BUNDLE: "e",
    GIT_SSL_CAINFO: "f",
  };
  const refused = {
    LCX: "no",
    AWS_REGION: "no",
    ANTHROPIC_API_KEY: "no",
    SKILL_EVALS_BIN_CODEX: "no",
    npm_lifecycle_script: "no",
    _: "no",
    HOME: "/real",
    XDG_CONFIG_HOME: "/real/.config",
  };
  const env = childEnv({ home: "/h", base: { ...base, ...refused }, ...NONE });
  expect(Object.keys(env).sort()).toEqual(
    [
      ...Object.keys(base),
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ].sort(),
  );
  expect(env["HOME"]).toBe("/h");
  expect(env["XDG_CONFIG_HOME"]).toBe("/h/.config");
  expect(env["XDG_DATA_HOME"]).toBe("/h/.local/share");
  expect(env["XDG_STATE_HOME"]).toBe("/h/.local/state");
  expect(env["XDG_CACHE_HOME"]).toBe("/h/.cache");
});

test("proxy and certificate variables pass in both cases", async () => {
  const proxies = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];
  const base = Object.fromEntries(
    proxies.flatMap((name) => [
      [name, "upper"],
      [name.toLowerCase(), "lower"],
    ]),
  );
  const env = childEnv({ home: "/h", base, ...NONE });
  for (const name of proxies) {
    expect(env[name]).toBe("upper");
    expect(env[name.toLowerCase()]).toBe("lower");
  }
  const names = await seenNames({
    env: { HTTPS_PROXY: "http://p:1", https_proxy: "http://p:2" },
  });
  expect(names).toContain("HTTPS_PROXY");
  expect(names).toContain("https_proxy");
});

test("a harness auth variable passes, and only the ones the adapter lists", () => {
  const base = { ANTHROPIC_API_KEY: "k", AWS_REGION: "r", AWS_OTHER: "o" };
  const env = childEnv({
    home: "/h",
    base,
    ...NONE,
    authEnv: ["ANTHROPIC_API_KEY", "AWS_REGION"],
  });
  expect(env["ANTHROPIC_API_KEY"]).toBe("k");
  expect(env["AWS_REGION"]).toBe("r");
  expect(env["AWS_OTHER"]).toBeUndefined();
});

test("the decision key is still withheld when listed in env", () => {
  const base = { DECISION_KEY: "secret", ANTHROPIC_API_KEY: "k" };
  const env = childEnv({
    home: "/h",
    base,
    harnessEnv: { DECISION_KEY: "secret" },
    authEnv: ["ANTHROPIC_API_KEY"],
    pass: ["DECISION_KEY"],
    withhold: ["DECISION_KEY", "ANTHROPIC_API_KEY"],
  });
  expect(env["DECISION_KEY"]).toBeUndefined();
  expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
});

test("the adapter's own variables are added", () => {
  const env = childEnv({
    home: "/h",
    base: {},
    ...NONE,
    harnessEnv: { CLAUDE_CONFIG_DIR: "/h/.claude" },
  });
  expect(env["CLAUDE_CONFIG_DIR"]).toBe("/h/.claude");
});
