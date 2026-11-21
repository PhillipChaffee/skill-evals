---
title: Write a case
description: The files of a case, how to write its prompt, and how to choose its checks.
---

## Pick the question a case asks

A case asks one of two questions about a skill. Decide which one before you write the prompt.

| Question                             | The prompt                                                                                                | The checks                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| What does the skill do when it runs? | Invokes the skill by name, as you would in real use: `Use the commit-message skill to write the message.` | Are about the result: the final answer, a file, a tool call, or what a model says of the answer. |
| Does the skill load when it should?  | Does not name the skill.                                                                                  | `skill_loaded`, or `skill_not_loaded` for a request the skill should stay out of.                |

Do not ask both in one case. When a prompt leaves the skill out and the checks are about the result, a low score has two causes that look the same: the agent did not load the skill, or it loaded the skill and the skill did poor work. One case for each question tells you which.

A case that invokes the skill does not need `skill_loaded`, and the check says little there. A prompt that names a skill can make the agent call the harness's skill tool with that name even when the skill is not installed, and that call counts as a load. One of two Claude Code runs with no skills did that on 2026-11-21.

## The files of a case

A case is a directory under `evals/cases/`, at any depth. Its path below that directory is the case id. [Organise a suite](organise-a-suite.md) covers nested folders, tags, and selecting cases.

| File         | Content                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.md`  | The prompt, exactly as a user would type it. Nothing else.                                                                                             |
| `case.json`  | `{ "checks": [...], "weight": 1, "minScore": 0.5, "maxTurns": 6, "timeoutSeconds": 600 }`. Only `checks` is required, and it needs at least one check. |
| `workspace/` | Optional. Files the agent finds in its working directory.                                                                                              |

Every check takes an optional `weight`, a positive number that defaults to 1.

A case file can also say what a harness must be able to do to run it. These keys are described in [Needs and not-applicable cases](#needs-and-not-applicable-cases).

[Checks](../reference/checks.md) lists every check type with its fields.

In every harness, "loaded a skill" means that the agent called the harness's skill tool with that skill's name, or that any tool call pointed at `skills/<name>/SKILL.md`.

`timeoutSeconds` defaults to 600. `maxTurns` has no default, and only Claude Code has a flag for it. The time limit alone bounds the other harnesses.

A prompt can start with any character. One that starts with a dash reaches the agent as the prompt and is not read as a flag of the harness.

The agent must not be able to tell that its answer is being measured. Write the prompt as a plain request, and keep these words out of the prompt and out of every file name under `workspace/`: `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, `arena`. Naming the skill that the prompt invokes is fine: that is how a person asks for it. Do not ask the agent which skills it used. The checks read that from its tool calls. The rubric stays in `case.json`, which the agent's workspace never holds. A plugin is loaded from where it is on disk, so the agent can see that path, and the cases too when they are inside the plugin's folder.

## Strict keys

A key that a case file does not take is a load error. The error names the key, the check type, and the keys that type takes, so a typo such as `pth` cannot silently turn a check into a different one.

```json
{
  "x-owner": "platform team",
  "checks": [
    { "type": "file_exists", "path": "notes.txt", "x-ticket": "OPS-12" }
  ],
  "timeoutSeconds": 300
}
```

A key that starts with `x-` is yours. Loading keeps it, nothing reads it, and `results.json` repeats it: a case's `x-` keys are in `caseMeta` under the case id, and a check's own `x-` keys are in its entry of the run record.

`--lenient` (or `"lenient": true` in the config file) loads a file that has other unknown keys. It drops each one and prints one warning for it on standard error. It exists for a suite that was written before keys were checked, and it is for one release.

## Check the file in your editor

The package ships `schema/case.schema.json`. Add `"$schema": "../../../node_modules/skill-evals/schema/case.schema.json"` (a path relative to the case file) as the first key of a `case.json`, and an editor that reads JSON Schema offers the keys and check types and flags a wrong one as you type. The tool allows the `$schema` key, as a string only, and ignores it. See [the config reference](../reference/config.md#json-schemas) for the config file.

## Check a suite before you run it

`skill-evals validate` loads every case and reports every problem at once, without starting a harness or spending anything. A case that does not load (an unknown key, a regular expression that does not compile, an unsafe path, a bad tag or variant id) is a problem, and the command exits 2. A warning does not change the exit code: a `targets` name or a check's `skill` that is not a skill of the subject (a `skill_not_loaded` check may name an absent skill), and each case that an installed harness would report as not applicable, with what it lacks.

```sh
skill-evals validate --subject ./my-skills
```

It takes `--subject` (default: the project; `none` skips the skill names), `--cases`, `--lenient` (an unknown key becomes a warning), `--heldout` and the selection flags. A directory name with `@` or `,` is reported even for a case that the selection leaves out, because no case id can be formed for it. Each line reads `problem <case id>: <message>` or `warning <case id>: <message>`, problems first, then `<n> cases, <p> problems, <w> warnings`.

## Needs and not-applicable cases

Harnesses report different things. A case or a check can name what it needs, and a harness that lacks it reports the case as not applicable: no runs, no score, and a line in the report. [Capabilities](../concepts/capabilities.md) lists the names and which harness declares which.

| Key             | Where           | Holds                                                                                                                                |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `requires`      | case or a check | A list of capability names, or `bin:<name>` for an executable on `PATH`. An unknown name is a load error that lists the known names. |
| `ifUnsupported` | a check         | `"skip"` drops this check on a harness that lacks what it needs, and re-normalizes the weights. The default is `"not-applicable"`.   |
| `harnesses`     | case            | The harness ids the case is for. A last resort. It needs a `note`.                                                                   |
| `note`          | case            | Why the case is limited to `harnesses`. The report shows it as the reason.                                                           |

This case needs `git` on the machine, and it still runs on a harness that cannot see subagents, because that one check is skipped there:

```json
{
  "requires": ["bin:git"],
  "checks": [
    { "type": "tool_called", "kind": "shell", "inputMatches": "git log" },
    { "type": "output_contains", "text": "done" },
    {
      "type": "tool_not_called",
      "kind": "subagent",
      "requires": ["subagents"],
      "ifUnsupported": "skip"
    }
  ],
  "timeoutSeconds": 300
}
```

A skipped check changes what the case's score means on that harness, so the report lists the case under "Ran with checks skipped". Only the common-set score, over the cases that apply to every harness, compares harnesses.

## Tool checks

`kind` says what the tool does, with the same word in every harness. Use it so that a case works in each harness. [Tool kinds](../reference/checks.md#tool-kinds) lists the words.

`name` is a regular expression for the harness's own tool name, for example `^Bash$` in Claude Code. A check with `name` works in one harness only, so prefer `kind`. `inputMatches` is a regular expression for the call's input, written as JSON. `flags` applies to both expressions.

```json
{ "type": "tool_not_called", "kind": "shell", "inputMatches": "git push" }
```

### Count, order and first action

A tool check can say how many calls, in what order, and what came first. They all describe a call with the same shape, a matcher: `kind`, `name`, `inputMatches` and `flags`, with at least one of the first three. The `flags` of a matcher apply to that matcher's own `name` and `inputMatches`. The keys `by` and `inputLinesMax` are reserved for later; a matcher that sets one is a load error (`"by" is not yet supported`), never ignored.

`tool_called` takes `min` (default 1) and `max` (default none) for the number of matching calls, so a 0.0.1 `tool_called` with neither still means "at least one". `min` above `max` is a load error. `sameTurn: true` counts only calls that one assistant turn issued together, which needs a harness with the `turnGrouping` capability (Claude Code today); on any other harness the case is not applicable. `tool_not_called` is `tool_called` with `max: 0`.

```json
{
  "type": "tool_called",
  "kind": "subagent",
  "inputMatches": "synthesizer",
  "min": 1,
  "max": 1
}
```

`tool_order` takes either a pair or a sequence. The pair, `before` and `after`, passes when the chosen `before` call comes earlier than the chosen `after` call. Each side is a matcher with `which`, `"first"` (the default) or `"last"`. This one says a failing run of the tests came before the first source edit, and that the tests ran again after the last edit:

```json
{
  "type": "tool_order",
  "before": { "kind": "shell", "inputMatches": "npm test" },
  "after": { "kind": "edit", "inputMatches": "src/" }
}
```

```json
{
  "type": "tool_order",
  "before": { "kind": "edit", "which": "last" },
  "after": { "kind": "shell", "inputMatches": "npm test", "which": "last" }
}
```

A `sequence` is a list of matchers that must match calls in that order, with other calls allowed between. With `strict: true` a matcher may match many calls, but no call of a later matcher comes before the first match of an earlier one, and no call of an earlier matcher comes after the first match of a later one. This is how "two researchers, then one synthesizer, and no researcher after it" is written:

```json
{
  "type": "tool_order",
  "sequence": [
    { "kind": "subagent", "inputMatches": "researcher" },
    { "kind": "subagent", "inputMatches": "synthesizer" }
  ],
  "strict": true
}
```

`first_tool` checks the first tool call: `matches` is the matcher it must fit, and `ignoring` lists matchers for calls that may come before it, such as a read the agent is allowed to make first. `skill_loaded` takes `first: true` for "the first skill load is this skill, and no call outside `ignoring` came before it", and `anyOf`, a list of skills of which any is accepted, in place of `skill`. A skill load is a call of the harness's skill tool that names a skill, or a call whose input points at `skills/<name>/SKILL.md`. A `skill_loaded` with only `skill` scores as it always did.

```json
{
  "type": "skill_loaded",
  "skill": "magic-mode",
  "first": true,
  "ignoring": [{ "kind": "read", "inputMatches": "harness-adapter" }]
}
```

Until checks can tell agents apart, every one of these sees all the calls of the run, those of a subagent included. Claude Code flattens a subagent's calls into the list. A failing check shows the calls around the one that failed, one line each: `#<index> t<turn> <agent> <kind> <name> <input>`. The full cases are in `examples/cases/tool-order` and `examples/cases/first-tool`.

Harnesses do not split work the same way. One harness has a search tool, and another runs `grep` through its shell tool, so `tool_called` with `"kind": "search"` can score 0 for an agent that did search. Tool calls that a subagent made count in the harnesses whose stream includes them (seen in Claude Code).

## Checks that a model scores

Use a `judge` check or a `decision` check for a quality that no pattern can find. [Judged checks](judged-checks.md) and [Decision checks](decision-checks.md) say how each is scored and configured.
