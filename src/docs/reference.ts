import { CASE_KEYS } from "../cases.js";
import { FIELDS } from "../checks/fields.js";
import type { Spec } from "../checks/index.js";
import { CHECKS } from "../checks/index.js";
import { COMMANDS } from "../cli.js";
import { HARNESSES, overrideVar } from "../harnesses/index.js";
import { TOOL_KIND_MEANINGS } from "../harnesses/shared.js";
import { ENV_NAME_RULE } from "../env.js";
import { CONFIG_FILE, CONFIG_KEYS } from "../project.js";
import { VARIANT_KEYS } from "../variants.js";
import type { Flag, FlagSpec } from "../flags.js";
import { EXAMPLE_CONFIG } from "./example-config.js";
import { FLAGS } from "../flags.js";
import { commandsTaking, defaultText, flagSyntax } from "../usage.js";
import { apiReference } from "./api.js";
import { capabilitiesPage } from "./capabilities-page.js";
import { exitCodesPage } from "./exit-codes-page.js";
import { transcriptPage } from "./transcript-page.js";
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

The keys of a ${code("case.json")}. Any other key is a load error, except a key that starts with ${code("x-")} and ${code("$schema")}, a string that points an editor at [the schema](config.md#json-schemas).

${table(
  ["Key", "Type", "Holds"],
  Object.entries(CASE_KEYS).map(([key, { type, meaning }]) => [
    code(key),
    code(type),
    meaning,
  ]),
)}

## Variant keys

The keys of an object in the ${code("variants")} list. A variant needs ${code("id")} and exactly one of ${code("prompt")} and ${code("promptAppend")}. Any other key is a load error, except a key that starts with ${code("x-")}. See [Organise a suite](../guides/organise-a-suite.md#variants).

${table(
  ["Key", "Type", "Holds"],
  Object.entries(VARIANT_KEYS).map(([key, { type, meaning }]) => [
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

${code("skill-evals --help")}, ${code("skill-evals help")}, ${code("skill-evals help <command>")} and ${code("skill-evals <command> --help")} print the help text on standard output and exit 0; ${code("--help")} wins over every other flag. A wrong command line prints the same commands and flags on standard error and exits 2.

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
  judgeKeyVar: `The variable that holds the key of the judge API. The agent under test never gets it, unless it is one of that harness's own login variables. Default: ${code("ANTHROPIC_API_KEY")}.`,
  judgeTimeout: `The seconds one request to the judge API may take. A positive integer. A timeout counts as a failed attempt. Default: 120.`,
  judgeFallbacks: `Ask the judge API to fall back when the model refuses: the ${code("anthropic-beta")} header and ${code('fallbacks: "default"')} in the request. Set it to ${code("false")} for a proxy that rejects them. Default: ${code("true")}.`,
  maxJudgedWeightShare: `The share of a case's total check weight, from 0 to 1, that ${code("judge")} and ${code("decision")} checks may carry before ${code("validate")} warns. Default: 0.5.`,
  env: `Names of environment variables the harness gets besides the allowlist. ${ENV_NAME_RULE} Anything else is an error.`,
  subjectExclude: `Globs, relative to the subject, of paths that a run never gets: they are left out of its copy, besides ${code(".git")}, ${code("node_modules")}, the cases directory and the output directory. ${code("*")} matches within one directory, ${code("**")} matches any depth, ${code("?")} one character, and ${code("{a,b}")} either. See [Subjects](../concepts/subjects.md).`,
};

/**
 * Says what a config key does.
 * @param key - A key of the config file.
 * @returns The sentence the config page shows for it: its own text, or the description of the flag it is the default of.
 */
export const configMeaning = (key: string): string =>
  CONFIG_ONLY[key] ??
  flagsOf(key)
    .map((flag) => FLAGS[flag].description)
    .join(" ");

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
    configMeaning(key),
  ]),
)}

Every key is optional. ${code("cases")} resolves against the project root. ${code("harness")} narrows ${code("check")} too. An unknown key, a value of the wrong type, or invalid JSON is an error with exit code 2.

A file that sets every key. It shows each key's type, and is not a file to run with: ${code("maxCost")} is a usage error when a selected case has a decision check, which reports no cost, and when the judge is the API (${code("judgeApi")}). The decision model alone is fine: it is only used when a case has a decision check.

${FENCE}json
${JSON.stringify(EXAMPLE_CONFIG, null, JSON_INDENT)}
${FENCE}

## JSON Schemas

The package ships a JSON Schema for the config file and one for ${code("case.json")}, so that an editor can check a file as you type and offer its keys. They are JSON Schema 2020-12, and they are written from the same tables as this page and [Checks](checks.md), so they cannot drift from what the tool accepts. Point an editor at one with a ${code("$schema")} key, which the tool allows, and ignores, in both files and which must be a string:

${FENCE}json
{
  "$schema": "./node_modules/skill-evals/schema/config.schema.json",
  "reps": 3
}
${FENCE}

In a ${code("case.json")}, use ${code("schema/case.schema.json")} of the same package, with a path relative to the case file, such as ${code("../../../node_modules/skill-evals/schema/case.schema.json")}. The ${code("$id")} of each schema is under ${code("https://phillipchaffee.github.io/skill-evals/schema/")}.

The schemas check what one value can show. They do not check that a decision check has exactly one of ${code("expect")} and ${code("options")}, that a regular expression compiles, that a variant id is unique within its case, that a variant's ${code("promptAppend")} has a ${code("prompt.md")} with text to append to, that a case has a prompt source, that a ${code("prompt")} or ${code("promptAppend")} is more than whitespace, that ${code("flags")} is a valid set of flags, that an ${code("options")} answer has a name, or that a case directory name has no ${code("@")} or ${code(",")}, so a file can pass the schema and still fail to load. A weight of ${code("null")} passes, because the loader takes it as no weight. ${code("skill-evals list")} checks the rest.
`,
});

const ISOLATED = code("--isolated");

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

${ISOLATED} starts the harness with nothing loaded but the subject, and invalidates a run whose own report of what it loaded shows anything else. The ${code("isolated")} capability means that the adapter does the first and proves the second from its report, so ${ISOLATED} needs ${code("loadedReport")} too. A harness without both is a usage error that names it, raised before a run starts. Flags are never trusted, and a harness that should report its plugins and skills but does not makes the run invalid with ${code("the harness did not report what it loaded")}. Under ${ISOLATED} the judge, which loads nothing, must have both capabilities too, gets the same switches, and what it reports is held to the same rule.

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

${HARNESSES.flatMap((harness) =>
  harness.isolation
    ? [
        `### What ${code(harness.id)} does with these switches\n\n${harness.isolation.notes}`,
      ]
    : [
        `### ${code(harness.id)}\n\nCannot run with ${ISOLATED}. ${harness.isolationGap ?? "It has not been proven to load nothing but the subject."}`,
      ],
).join("\n\n")}
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
 * @returns The pages: checks, commands and flags, the exit codes, the config file, the API, the harnesses, the capabilities, and the transcript.
 */
export const referencePages = (): ReferencePage[] => [
  checksPage(),
  commandsPage(),
  exitCodesPage(),
  configPage(),
  apiPage(),
  harnessesPage(),
  capabilitiesPage(),
  transcriptPage(),
];
