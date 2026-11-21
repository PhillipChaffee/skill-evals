import { CASE_KEYS } from "../cases.js";
import { FIELDS } from "../checks/fields.js";
import type { Spec } from "../checks/index.js";
import { CHECKS } from "../checks/index.js";
import { COMMANDS } from "../cli.js";
import { HARNESSES, overrideVar } from "../harnesses/index.js";
import { TOOL_KIND_MEANINGS } from "../harnesses/shared.js";
import { ENV_NAME_RULE } from "../env.js";
import { CONFIG_FILE, CONFIG_KEYS } from "../project.js";
import type { Flag, FlagSpec } from "../usage.js";
import { FLAGS, commandsTaking, defaultText, flagSyntax } from "../usage.js";
import { apiReference } from "./api.js";
import { capabilitiesPage } from "./capabilities-page.js";
import type { ReferencePage } from "./markdown.js";
import { FENCE, code, header, table } from "./markdown.js";

const JSON_INDENT = 2;

/**
 * Lists the fields of a check type the way the checks table shows them.
 * @param spec - The check type.
 * @returns The required fields, then the ones of which at least one must be set, then the optional ones, then the
 *   type's own note.
 */
function fieldsCell(spec: Spec): string {
  const oneOf = spec.oneOf ?? [];
  const optional = (spec.optional ?? []).filter(
    (field) => !oneOf.includes(field),
  );
  const parts = [
    ...spec.fields.map(code),
    ...(oneOf.length ? [`at least one of ${oneOf.map(code).join(", ")}`] : []),
    ...optional.map((field) => `optional ${code(field)}`),
  ];
  return [parts.join(", "), ...(spec.note ? [spec.note] : [])].join(". ");
}

const checksPage = (): ReferencePage => ({
  file: "reference/checks.md",
  markdown: `${header(
    {
      title: "Checks",
      description:
        "Every check type a case can hold, with its fields and what it scores.",
    },
    "src/checks/",
  )}

A check is one object in the ${code("checks")} list of a ${code("case.json")}. Every check has a ${code("type")}, and takes an optional ${code("weight")}, a positive number that defaults to 1. [Write a case](../guides/write-a-case.md) shows how to use them.

## Check types

${table(
  ["Check", "Fields", "Scores 1 when"],
  Object.entries(CHECKS).map(([type, spec]) => [
    code(type),
    fieldsCell(spec),
    spec.scores,
  ]),
)}

## Fields

${table(
  ["Field", "Type", "Holds"],
  Object.entries(FIELDS).map(([field, { type, meaning }]) => [
    code(field),
    code(type),
    meaning,
  ]),
)}

## Case file keys

The keys of a ${code("case.json")}. Any other key is a load error, except a key that starts with ${code("x-")}.

${table(
  ["Key", "Type", "Holds"],
  Object.entries(CASE_KEYS).map(([key, { type, meaning }]) => [
    code(key),
    code(type),
    meaning,
  ]),
)}

## Tool kinds

A ${code("kind")} is one of these words.

${table(
  ["Kind", "Meaning"],
  Object.entries(TOOL_KIND_MEANINGS).map(([kind, meaning]) => [
    code(kind),
    meaning,
  ]),
)}
`,
});

const FLAG_NAMES = Object.keys(FLAGS) as Flag[];

const commandsPage = (): ReferencePage => ({
  file: "reference/commands.md",
  markdown: `${header(
    {
      title: "Commands and flags",
      description:
        "Every command and flag of the skill-evals command line, with its default.",
    },
    "src/cli.ts and src/usage.ts",
  )}

A wrong command line prints the same commands and flags as its help text.

## Commands

${table(
  ["Command", "What it does"],
  Object.entries(COMMANDS).map(([name, command]) => [
    code(name),
    command.description,
  ]),
)}

## Flags

${table(
  ["Flag", "Commands", "Default", "Meaning"],
  FLAG_NAMES.map((flag) => [
    code(flagSyntax(flag)),
    commandsTaking(COMMANDS, flag).map(code).join(", "),
    defaultText(COMMANDS, flag),
    FLAGS[flag].description,
  ]),
)}

A subject is what a run loads: a directory, a git ref of the project, or ${code("none")}. [Subjects](../concepts/subjects.md) has the details. [Set a pass bar](../guides/pass-bars.md) explains ${code("--min-score")} and the exit codes, and [Decision checks](../guides/decision-checks.md) explains the decision model's flags.
`,
});

const CLAUDE_CODE = "claude-code";

// A config file that sets every key. The tests make sure that it has exactly the keys of CONFIG_KEYS, each with a
// value of the key's type, and that the tool accepts it.
export const EXAMPLE_CONFIG: Record<
  string,
  string | number | boolean | string[]
> = {
  cases: "evals/cases",
  harness: CLAUDE_CODE,
  reps: 3,
  model: "<model-id>",
  judgeHarness: CLAUDE_CODE,
  judgeModel: "<model-id>",
  decisionModel: "<decision-model-id>",
  decisionUrl: "<base-url>",
  decisionTimeout: 60,
  minScore: 0.8,
  lenient: false,
  isolated: false,
  env: ["AWS_ENDPOINT_URL"],
  subjectExclude: ["evals/cases/**", "notes/**"],
};

/**
 * Finds the flags a config key is the default of.
 * @param key - A key of the config file.
 * @returns The flags that set the option of the same name: one for every key the tool has today.
 */
const flagsOf = (key: string): Flag[] =>
  FLAG_NAMES.filter((flag) => {
    const spec: FlagSpec = FLAGS[flag];
    return (spec.as ?? flag) === key;
  });

// Keys that no flag sets.
const CONFIG_ONLY: Record<string, string> = {
  env: `Names of environment variables the harness gets besides the allowlist. ${ENV_NAME_RULE} Anything else is an error.`,
  subjectExclude: `Globs, relative to the subject, of paths that a run never gets: they are left out of its copy, besides ${code(".git")}, ${code("node_modules")}, the cases directory and the output directory. ${code("*")} matches within one directory, ${code("**")} matches any depth, ${code("?")} one character, and ${code("{a,b}")} either. See [Subjects](../concepts/subjects.md).`,
};

const configPage = (): ReferencePage => ({
  file: "reference/config.md",
  markdown: `${header(
    {
      title: "Config file",
      description: `Every key of ${CONFIG_FILE}, with the flag it is the default of.`,
    },
    "src/project.ts",
  )}

An optional ${code(CONFIG_FILE)} in the project root sets defaults. A flag wins over the file.

${table(
  ["Key", "Type", "Default of", "Meaning"],
  Object.entries(CONFIG_KEYS).map(([key, type]) => [
    code(key),
    type,
    flagsOf(key)
      .map((flag) => code(flagSyntax(flag)))
      .join(", ") || "none",
    CONFIG_ONLY[key] ??
      flagsOf(key)
        .map((flag) => FLAGS[flag].description)
        .join(" "),
  ]),
)}

Every key is optional. ${code("cases")} resolves against the project root. ${code("harness")} narrows ${code("check")} too. An unknown key, a value of the wrong type, or invalid JSON is an error with exit code 2.

A file that sets every key:

${FENCE}json
${JSON.stringify(EXAMPLE_CONFIG, null, JSON_INDENT)}
${FENCE}
`,
});

const ISOLATED = code("--isolated");

/**
 * Names the harnesses that cannot run with `--isolated`, and why.
 * @returns A sentence; the harnesses are the registry's, so it changes with their capabilities.
 */
const isolatable = (): string => {
  const lacking = HARNESSES.filter(
    (harness) =>
      !harness.isolation || !harness.capabilities.has("loadedReport"),
  ).map((harness) => code(harness.id));
  return `Today ${lacking.join(", ")} cannot run with it. Pi is started with discovery switched off (${code("-ne -ns -np")}) whatever the flag says, and that stays its default, but it reports nothing it loaded, so it cannot run ${ISOLATED} until an adapter can prove what it loaded.`;
};

// What was read in the code of Claude Code 2.1.330, which is not in its help text.
const CLAUDE_NOTES = `### What Claude Code does with these switches

- ${code("--setting-sources user")}: the CLI loads ${code("CLAUDE_CONFIG_DIR/skills")}, the user's settings and the user's plugins only for the ${code("user")} source, and the workspace's ${code(".claude/")} skills and settings only for ${code("project")} and ${code("local")}. User level is the throwaway home, which holds only what the run puts there, such as the skills of a skills subject. An empty list (${code('""')}) is accepted by the parser, but it would leave a skills subject unloaded.
- ${code("--strict-mcp-config")}: only the servers of ${code("--mcp-config")}. The CLI has a check that refuses ${code("--strict-mcp-config")} with the message "You cannot use --strict-mcp-config when an enterprise MCP config is present". Where it exits the process was not confirmed, so the foreign-server rule covers the case where the run starts anyway. A plugin's own MCP server is named ${code("plugin:<plugin>:<server>")} in the init event; every other server is outside the subject. Whether the flag also drops a plugin's own servers was not confirmed.
- ${code("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")}, ${code("CLAUDE_CODE_DISABLE_POLICY_SKILLS=1")} and ${code("CLAUDE_CODE_DISABLE_ORG_MEMORY=1")} switch off auto memory, the organization's managed policy skills, and the sync of organization memory. All three names are read by the compiled CLI.
- Never ${code("--bare")}: it also switches off the subject plugin's own hooks.
- A bare skill name that is not one of the subject's own counts as a Claude Code built-in, which is not outside the subject. Policy skills are switched off, so no managed skill appears as one. The built-in names were not confirmed against a real capture. A bare agent name is not judged, because the init event does not tell a built-in agent from a managed one. A plugin directory, a ${code("plugin:")}-prefixed skill or agent of another plugin, and an MCP server that is not the subject's are outside the subject.
- Organization-managed plugins load under every flag. The init event lists them, so the run is invalid.
- Not proven by the record: managed policy settings (hooks, environment, permissions), a managed ${code("CLAUDE.md")} file, rules, hooks, and managed agents. The report does not list them.`;

const harnessesPage = (): ReferencePage => ({
  file: "agents/harnesses.md",
  markdown: `${header(
    {
      title: "Harnesses",
      description:
        "The coding agents skill-evals can run, in the order it prefers them.",
    },
    "src/harnesses/index.ts",
  )}

A harness is a coding agent's command-line program. ${code("run")} and ${code("score")} use the first installed harness in this order when you do not name one with ${code("--harness")}.

${table(
  ["Order", "Id", "Executable", "Variable that names another executable"],
  HARNESSES.map((harness, index) => [
    String(index + 1),
    code(harness.id),
    code(harness.bin),
    code(overrideVar(harness)),
  ]),
)}

[How each harness is started](how-they-run.md) says why the order is what it is and when to set the variable. [What was verified](verified.md) says how far each adapter is proven.

## Isolation

${ISOLATED} starts the harness with nothing loaded but the subject, and invalidates a run whose own report of what it loaded shows anything else. The ${code("isolated")} capability means that the adapter does the first and proves the second from its report, so ${ISOLATED} needs ${code("loadedReport")} too. A harness without both is a usage error that names it, raised before a run starts. ${isolatable()} Flags are never trusted, and a harness that should report its plugins and skills but does not makes the run invalid with ${code("the harness did not report what it loaded")}. Under ${ISOLATED} the judge, which loads nothing, gets the same switches when its harness can take them, and what it reports is held to the same rule.

${table(
  [
    "Harness",
    "Switches added by --isolated",
    "What the report proves",
    "Not proven",
  ],
  HARNESSES.flatMap((harness) =>
    harness.isolation
      ? [
          [
            code(harness.id),
            [
              code(harness.isolation.args.join(" ")),
              ...Object.entries(harness.isolation.env).map(([name, value]) =>
                code(`${name}=${value}`),
              ),
            ].join(" "),
            harness.isolation.proves,
            harness.isolation.notProven,
          ],
        ]
      : [],
  ),
)}

${CLAUDE_NOTES}
`,
});

const apiPage = (): ReferencePage => ({
  file: "reference/api.md",
  markdown: `${header(
    {
      title: "API",
      description:
        "Everything the skill-evals package exports, with its options and result types.",
    },
    "the doc comments of what src/index.ts exports",
  )}

${FENCE}js
import { evaluate, loadCases, HARNESSES } from "skill-evals";
${FENCE}

[Use it from code](../guides/from-code.md) shows an evaluation from start to end. The package ships type declarations, so everything on this page is typed in TypeScript.

${apiReference()}`,
});

/**
 * Writes every reference page from the tables and the doc comments in the code.
 * @returns The pages: checks, commands and flags, the config file, the API, the harnesses, and the capabilities.
 */
export const referencePages = (): ReferencePage[] => [
  checksPage(),
  commandsPage(),
  configPage(),
  apiPage(),
  harnessesPage(),
  capabilitiesPage(),
];
