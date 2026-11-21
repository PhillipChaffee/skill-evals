import { CAPABILITIES } from "../capabilities.js";
import { HARNESSES } from "../harnesses/index.js";
import type { ReferencePage } from "./markdown.js";
import { FENCE, code, header, table } from "./markdown.js";

// What each status of an adapter says about how far it is proven.
const STATUS_MEANINGS = {
  "real-model":
    "A real model ran through the adapter, so its stream is a capture.",
  scripted:
    "The real CLI ran through the adapter against a scripted model endpoint. No real model ran.",
  unverified:
    "The adapter was written from the CLI's documentation. No run confirmed it.",
} as const;

/**
 * Writes the part of the page that says what cases and checks can need, and what follows from it.
 * @returns The prose and the two example case files.
 */
const needs =
  (): string => `Coding agents do not report the same things. One shows which agent made each tool call, and another shows only the final answer. Each harness adapter declares the ${code("capabilities")} it can deliver. A case, or a check in it, can need some. A case that needs something the harness lacks is **not applicable** on that harness.

A not-applicable case has no runs and no score. The report lists it with the capabilities that are missing. It is never a pass and never a failure, because a check that cannot see what it looks for would pass or fail for the wrong reason.

## What a case needs

A case needs what its ${code("requires")} key lists, and what its checks need. A check needs what its own ${code("requires")} key lists, and what its type implies. A harness that lacks any of them cannot run the case.

${FENCE}json
{
  "requires": ["mcp", "bin:git"],
  "checks": [{ "type": "output_contains", "text": "done" }]
}
${FENCE}

A capability that begins with ${code("bin:")} is a host capability: an executable of that name on ${code("PATH")}. It is met on every harness when the executable is there, and on none when it is not. ${code("check")} prints the ones that the loaded cases ask for.

## Skip one check

By default one check that needs something missing makes the whole case not applicable. A check with ${code('"ifUnsupported": "skip"')} is dropped instead. The weights of the other checks are re-normalized, and the report lists the case under "Ran with checks skipped" with the skipped checks named. A case whose every check would be skipped is not applicable.

${FENCE}json
{
  "checks": [
    { "type": "output_contains", "text": "done" },
    {
      "type": "tool_called",
      "kind": "subagent",
      "requires": ["childCalls"],
      "ifUnsupported": "skip"
    }
  ]
}
${FENCE}

## Name the harnesses

A ${code("harnesses")} list on a case limits it to those harness ids. It is a last resort, because the harness may gain the capability later. It needs a ${code("note")} that says why, and the report shows the note as the reason elsewhere.

## Scores across harnesses

Each harness's suite score is over its own applicable cases, and it is printed as ${code("score (n of N cases)")}. A harness with no applicable case gets a line in the report and no score. When more than one harness runs, the report adds a common-set score over the cases that apply to all of them. Only that number compares harnesses. If no case applies to any harness that ran, the command stops with exit code 2.`;

/**
 * Writes the part of the page that the tables of the code make.
 * @returns The meaning of each capability, and what each harness declares with its status.
 */
const declared = (): string => `## The capabilities

${table(
  ["Capability", "Meaning"],
  Object.entries(CAPABILITIES).map(([name, meaning]) => [code(name), meaning]),
)}

## What each harness declares

An adapter declares a capability only when a parser test proves it on a stream. ${code("yes")} means that it does. A cell that says ${code("no")} is not a claim that the harness cannot do it, only that no test proves it yet.

${table(
  ["Capability", ...HARNESSES.map((harness) => code(harness.id))],
  Object.keys(CAPABILITIES).map((name) => [
    code(name),
    ...HARNESSES.map((harness) =>
      (harness.capabilities as ReadonlySet<string>).has(name) ? "yes" : "no",
    ),
  ]),
)}

${table(
  ["Harness", "Status", "What the status says"],
  HARNESSES.map((harness) => [
    code(harness.id),
    code(harness.status),
    STATUS_MEANINGS[harness.status],
  ]),
)}

[What was verified](../agents/verified.md) says how each adapter was proven. [Write a case](../guides/write-a-case.md) shows the keys.`;

/**
 * Writes the page about capabilities and not-applicable cases.
 * @returns The page, generated from `CAPABILITIES` and from what each adapter declares.
 */
export const capabilitiesPage = (): ReferencePage => ({
  file: "concepts/capabilities.md",
  markdown: `${header(
    {
      title: "Capabilities and not-applicable cases",
      description:
        "What each harness can observe or do, and what a case does when its harness cannot.",
    },
    "src/capabilities.ts and src/harnesses/",
  )}

${needs()}

${declared()}
`,
});
