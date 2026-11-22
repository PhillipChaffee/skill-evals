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

A case that invokes the skill does not need `skill_loaded`, and the check says little there. A prompt that names a skill can make the agent call the harness's skill tool with that name even when the skill is not installed, and that call counts as a load, as an unresolved one: add `"resolved": true` to count only loads of the subject's own skills. One of two Claude Code runs with no skills did that on 2026-11-21.

## The files of a case

A case is a directory under `evals/cases/`, at any depth. Its path below that directory is the case id. [Organise a suite](organise-a-suite.md) covers nested folders, tags, and selecting cases.

| File         | Content                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.md`  | The prompt, exactly as a user would type it. Nothing else.                                                                                             |
| `case.json`  | `{ "checks": [...], "weight": 1, "minScore": 0.5, "maxTurns": 6, "timeoutSeconds": 600 }`. Only `checks` is required, and it needs at least one check. |
| `workspace/` | Optional. Files the agent finds in its working directory.                                                                                              |
| `fixture/`   | Optional. Files that only setup steps see, such as a script that builds a git history. [Setup, fixtures and home](#setup-fixtures-and-home).           |
| `home/`      | Optional, and named by the `home` key. Files copied into the agent's throwaway home.                                                                   |

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

A tool check can say how many calls, in what order, and what came first. They all describe a call with the same shape, a matcher: `kind`, `name`, `inputMatches` and `flags`, with at least one of the first three, or `by`. The `flags` of a matcher apply to that matcher's own `name` and `inputMatches`. `inputLinesMax` and `inputLinesMin` bound the lines of a call's input, counted in the longest string value found anywhere in it, so `{ "kind": "edit", "inputLinesMax": 20 }` fits only small edits. They are matcher keys, so they are also fields of `tool_called` and `tool_not_called`. A call matches when it fits every key, so `inputLinesMax` on `tool_not_called` says that no _small_ call was made, which is rarely what you want. To say that no single write was long, use `inputLinesMin` with one more than the limit:

```json
{ "type": "tool_not_called", "kind": "write", "inputLinesMin": 1001 }
```

A matcher also takes `by`, which says whose calls fit: see [Subagents](#subagents-scope-a-check-with-by).

`tool_called` takes `min` (default 1, or 0 when `max` is 0) and `max` (default none) for the number of matching calls, so a 0.0.1 `tool_called` with neither still means "at least one". `min` above `max` is a load error. `sameTurn: true` requires every matching call to have been issued in one assistant turn, so `min` and `max` count calls that were launched together: two researchers in one message and a third one later fails it, and a matching call with no turn fails it unless it is the only match. It needs a harness with the `turnGrouping` capability (Claude Code today); on any other harness the case is not applicable. `tool_not_called` is `tool_called` with `max: 0`.

```json
{
  "type": "tool_called",
  "kind": "subagent",
  "inputMatches": "synthesizer",
  "min": 1,
  "max": 1
}
```

`tool_order` takes either a pair or a sequence. The pair, `before` and `after`, passes when the chosen `before` call comes earlier than the chosen `after` call. Each side is a matcher with `which`, `"first"` (the default) or `"last"`. These two say that a run of the tests came before the first source edit, and that the tests ran again after the last edit. They do not say the first run failed: reading a tool's output arrives with the transcript checks (item 4):

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

`first_tool` checks the first tool call: `matches` is the matcher it must fit, and `ignoring` lists matchers for calls that may come before it, such as a read the agent is allowed to make first. `skill_loaded` takes `first: true` for "the first skill load is this skill, and no call outside `ignoring` came before it", and `anyOf`, a list of skills of which any is accepted, in place of `skill`. A skill load is one of the events described in [How a skill load is detected](#how-a-skill-load-is-detected).

```json
{
  "type": "skill_loaded",
  "skill": "magic-mode",
  "first": true,
  "ignoring": [{ "kind": "read", "inputMatches": "harness-adapter" }]
}
```

Without `by`, every one of these sees all the calls of the run, those of a subagent included. A failing check shows the calls around the one that failed, one line each: `#<index> t<turn> <agent> <kind> <name> <input>`. The full cases are in `examples/cases/tool-order` and `examples/cases/first-tool`.

Harnesses do not split work the same way. One harness has a search tool, and another runs `grep` through its shell tool, so `tool_called` with `"kind": "search"` can score 0 for an agent that did search. Tool calls that a subagent made count in the harnesses whose stream includes them (seen in Claude Code).

### Subagents: scope a check with `by`

Every event of a Claude Code run belongs to the agent that produced it: an event with a `parent_tool_use_id` belongs to the agent that the dispatch call of that id started. The agent's `type` is the dispatch's `subagent_type` with any plugin prefix dropped (`magic:comment-sicko:comment-sicko` is `comment-sicko`; a dispatch with no type is `general-purpose`), and its `depth` is 0 for the main thread, 1 for an agent it started, 2 for that agent's own. The dispatch call and its result belong to the dispatcher. An event whose parent id names no known dispatch belongs to an agent of type `unknown`.

`by` takes `"main"` (depth 0), `"subagent"` (depth 1 or more) or `{ "agent": "<name>" }` (agents of that type; the name is normalized the same way). It is a key of every matcher, so it works in `tool_called`, `tool_not_called`, `first_tool`, `tool_order` (in `before`, `after` and `sequence`), in the `tool` of the `tool_output_*` checks and in the `before` and `after` of a `scope`; and it is a field of `skill_loaded`, `skill_not_loaded`, `transcript_matches` and `transcript_lacks`. A matcher with no `by` matches every agent, as in 0.0.1.

```json
{
  "checks": [
    {
      "type": "tool_not_called",
      "kind": "edit",
      "by": { "agent": "researcher" }
    },
    {
      "type": "tool_not_called",
      "kind": "edit",
      "inputMatches": "src/",
      "by": "main"
    },
    {
      "type": "tool_called",
      "kind": "read",
      "inputMatches": "workflow/SKILL\\.md",
      "by": { "agent": "delegate" },
      "first": true
    },
    { "type": "tool_called", "by": { "agent": "planner" }, "max": 0 }
  ]
}
```

`by` alone is enough for `tool_called` and `tool_not_called` (and for a matcher): the last check says the planner made no tool call at all. With `max: 0`, `min` defaults to 0, so that check passes when the planner made none. `tool_called` with `first: true` and `by` asks that the first call that agent made fits; without `by` it is the run's first call, as before. `skill_loaded` with `first: true` and `by` asks for that agent's first load, and that none of that agent's earlier calls fall outside `ignoring`. `first_message` and `final_message` read the main agent; with `by` they read that agent's first and last non-empty text. A claim about an agent needs that agent to have run: `tool_not_called`, `tool_called` with a count of 0, `skill_not_loaded`, `transcript_lacks` and `tool_output_lacks` with `by: { "agent": "X" }` score 0 with `no agent of type X ran` when no event of the run belongs to an agent of that type, so a typo or a delegate that was never dispatched cannot pass "X never did Y". `by: "subagent"` with no subagent keeps its plain meaning and passes. `{ "agent": "main" }` is a load error (use `by: "main"`). `{ "agent": "unknown" }` is allowed: it names the child events whose dispatch the stream never showed. A `transcript_lacks` whose agent ran but wrote no text of the tested kind also scores 0.

`by` needs capabilities: any `by` on a matcher or a skill check needs `childCalls`, and `by` on `transcript_matches` or `transcript_lacks` needs `childText`. Claude Code declares both. A harness that lacks one cannot tell the main thread from a subagent, so `by: "main"` would silently mean every agent; the case is not applicable there instead. `examples/cases/by-agent` is a whole case. A role that has no agent type (a "collector" that the kit describes only in the dispatch's brief) cannot be named with `by`; match its dispatch with `tool_called { kind: "subagent", inputMatches }` and order it with `tool_order`.

## What the agent said and what its tools returned

Four checks read the [transcript](../concepts/transcript.md) of the run. They need a harness that carries the part they read: `assistantText` for the agent's text between tool calls, `toolOutputs` for what each tool returned. Elsewhere the case is not applicable.

`transcript_matches` scores 1 when a regular expression matches one of the tested texts, and `transcript_lacks` when none does. `where` says what is tested: `assistant_text` (the default), `tool_input` (each call's input, written as JSON, as a matcher reads it), `tool_output`, or `all`. `scope` says which events: `any` (the default), `first_message`, `final_message`, `{ "before": matcher }` or `{ "after": matcher }`.

`first_message` is the main agent's first non-empty text, wherever it falls. In a kit whose correct first action is a tool call, the text before the first tool call is usually empty, so "the first message" is not "the text before any call". The first text may come after a skill load and a read and still count. To bound it, give `{ "first_message": true, "before": matcher }`: it scores 0, and says so, when that text comes after the matcher's first call, and otherwise tests the text. A matcher that matches no call leaves the text before it. `final_message` is the last non-empty text. Both read the main agent only; with `by: { "agent": "researcher" }` they read that agent's first and last non-empty text instead.

```json
{
  "type": "transcript_matches",
  "pattern": "timeout.*30",
  "flags": "i",
  "scope": { "first_message": true, "before": { "kind": "edit" } }
}
```

`{ "before": matcher }` and `{ "after": matcher }` cut at the first call that fits the matcher: the events before that call, or after it. A matcher that matches no call scores the check 0, and the reason names the matcher, for `transcript_lacks` as well. `transcript_lacks` scores 0 when the whole run has no events of the chosen `where` (no assistant text, no tool results, no calls), with the reason `the run has no <where> text to test`, because that usually means the capture is broken and an empty run does not show that the agent wrote nothing like the pattern. With `where` set to `tool_output` or `all`, a call in the window with no result also scores 0, with `call #<i> has no output, so it cannot be shown to lack the pattern`. When the run has such events but a found `before` or `after` cut leaves an empty window (the edit was the last call), it passes. `first_message` and `final_message` read assistant text, so giving them another `where` is a load error. `by` picks one agent's events: see [Subagents](#subagents-scope-a-check-with-by).

`tool_output_matches` and `tool_output_lacks` read the result of the calls that fit `tool`, a matcher. With `which: "first"` or `"last"` they look at one call; with `"any"` (the default) at all of them. The output is what the tool returned, not what the agent said it returned, so "red before green" is two checks, and an agent that only claims success, or runs `true`, scores 0:

```json
{
  "type": "tool_output_matches",
  "tool": { "kind": "shell", "inputMatches": "npm test" },
  "which": "first",
  "pattern": "\\bfail",
  "flags": "i"
}
```

A call that fits `tool` but has no result event is not a match for `tool_output_matches`; with `which` set to the one that is chosen, the check scores 0 with `call #<i> has no output`. `tool_output_lacks` fails closed: a chosen call with no output cannot be shown to lack the pattern. No call that fits `tool` scores 0 for both. `tool_output_size` takes `maxBytes` and an optional `tool`, and scores 0 when any output is larger; a call with no result is ignored.

Patterns run on the first 1,000,000 characters of each event's text, input or output, and are compiled once for the check, so the `g` and `y` flags behave. A failing reason quotes the events it is about, one line each: `#<index> <type> <first 120 characters>`. The full cases are in `examples/cases/transcript-matches` and `examples/cases/tool-output-matches`.

## How a skill load is detected

Each skill event has a mechanism (`via`), a position in the run's call list, and whether the skill is one of the loaded subject (`resolved`). Three mechanisms are real:

| `via`        | What counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skill_tool` | A call of the harness's skill tool that names a skill, with any `plugin:` prefix dropped from `skill`. It is `resolved` when the skill is one of the subject's and the name has no prefix or the prefix is the subject plugin's own name from its manifest; for a skills folder a prefixed name never resolves.                                                                                                                                                                                                                                                                |
| `file_read`  | A read-kind call whose path argument, followed through links and resolved against the workspace when it is relative, is the existing `SKILL.md` of one of the subject's skills, in the run's copy of the subject or in a copy that the adapter placed in the home. The adapter's `pathOf` says which argument.                                                                                                                                                                                                                                                                 |
| `shell_read` | A shell call with a command that starts with `cat`, `head`, `tail`, `less`, `bat`, `nl` or `sed -n` (after any `NAME=value` words) and names such a path. The command is split at `&&`, `\|\|`, `;` and `\|`, and at a `-c` script of `bash -lc '...'`, and quoted words are unquoted; a `cd` earlier in the same command string sets where a relative path starts. A redirection target (`>`, `>>`, `2>`, `&>`) and the body of a here-document are not reads, `sed` counts only with `-n` and without `-i`, and `$HOME` is not expanded inside single quotes. No shell runs. |

Nothing else is a load. A `grep`, `rg`, `ls`, `find` or `wc` that mentions the path is not one, and neither is a read of a path in the workspace, even when it looks like `skills/foo/SKILL.md`: a fixture cannot satisfy `skill_loaded`. A read of any other file under a subject skill's directory, such as `references/bug-fix.md`, is not a load. It is a `skill_file_read` event, which the check of that name scores. `skill_loaded` and `skill_not_loaded` take `via` (one mechanism or a list; default: the three) and `resolved`. `skill_available` and `skill_not_available` look at the harness's own list of the skills it loaded at startup, and apply only to a harness that reports one (the capability `skillListing`).

```json
{
  "type": "skill_file_read",
  "skill": "bug-fix",
  "path": "references/*.md"
}
```

The run record keeps the events as `skillEvents`, and `skillsLoaded` is the sorted names of its loads. A harness reads files in its own way: Codex has no read tool and reads through shell commands (`bash -lc 'cat ...'`), so its loads are `shell_read`, and it reads the plugin from its own plugin cache, which the adapter finds after setup. Each adapter's `pathOf` says which argument names the file of a read call: `file_path` for Claude Code, and `path` for Pi and Cursor, which the Claude Code and Pi captures show; the Cursor stream is the example in Cursor's documentation, not a live capture. For OpenCode it takes `filePath`, `path` or `file_path`, from its documentation and not from a captured read call.

`skill_available` and `skill_not_available` score 0 when the harness reported no skills at all, because that proves nothing either way.

**Migration.** 0.0.1 counted any tool input that mentioned `skills/<name>/SKILL.md`, so a `grep` across the skills, a listing, or a fixture could score a load. That is fixed, and it is the one change to what an existing suite scores. For one release, `--lenient` keeps the 0.0.1 rule for a `skill_loaded` or `skill_not_loaded` that has neither `via` nor `resolved`.

## File checks

The tool hashes the workspace before the harness starts and again after the run, so a check can say what the agent left, and what it did not touch. `file_exists` and `file_matches` still take a plain path. Every file check's `path` is a glob when it holds `*`, `?` or `{`: `*` and `?` stay within a directory, `**` crosses directories, and `{a,b}` matches either. A glob never goes through a link. A path that leads out of the root through a link counts as absent, so a link to `/etc` cannot make `etc/passwd` exist. A glob that matches more than 5000 paths scores 0, and the reason names the glob and the cap.

| Check                | What it scores                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `file_exists`        | A file is at `path`. `created: true` needs one that the seed lacked.                       |
| `file_absent`        | Nothing is at `path`.                                                                      |
| `file_matches`       | A file at `path` matches `pattern`. With a glob, `quantifier` is `any` (default) or `all`. |
| `file_lacks`         | No file at `path` matches `pattern`. `quantifier` is `all` (default) or `any`.             |
| `file_unchanged`     | No file at `path` was created, modified or deleted.                                        |
| `file_changed`       | A file at `path` was created, modified or deleted.                                         |
| `files_changed_only` | Every changed path matches a glob of `allow`, once the globs of `ignore` are left out.     |
| `file_count`         | `path` matches from `min` (default 1) to `max` files.                                      |
| `dir_exists`         | A directory is at `path`.                                                                  |
| `file_lines`         | Every file at `path` has from `min` to `max` lines; give at least one.                     |

A plain path that names a directory, or ends in `/`, means every file under it for `file_absent`, `file_lacks`, `file_unchanged`, `file_changed`, `file_count`, `file_lines`, and the `allow` and `ignore` of `files_changed_only`. `file_exists`, `file_matches` and `dir_exists` read a plain path as the one entry it names, so a trailing `/` does not change them: `file_exists` on `src/` scores 0, as it always did. `file_absent` on a plain directory path scores 1 when no file is left under it, even if the directory exists. A glob counts files in `file_matches`, `file_lacks`, `file_count` and `file_lines`, so a directory named `x.md` is not counted by `*.md` and its contents are not listed, while `file_absent` and `dir_exists` also see the directories it matches. A plain directory path that is a link, or goes through one, that stays inside the root is listed from its real directory. A directory that cannot be listed, before the run or after it, and could hold a match of the path or glob (the glob's literal directory and it are on one path, or the glob starts with a wildcard), makes `file_lacks`, `file_absent`, `file_unchanged`, `file_lines` and `files_changed_only` score 0 with the reason `<dir> cannot be listed`; `file_count` does too when it has a `max`, and `file_changed` names it when it finds nothing. A path or glob may not start with `./`, which is a load error. A change check compares content, so a mode-only change is not a change, and it matches physical paths: a link is its own path, and its target is not followed. A glob that matches no file scores 0 for `file_exists`, `file_matches`, `file_changed`, `file_lines` and `dir_exists`, and 1 for `file_lacks` and `file_absent`. `file_unchanged` scores 0 when the seed had matching files and they are gone, and 1 when neither the seed nor the workspace has one. Every check takes `root`, `"workspace"` (default) or `"home"`, the run's throwaway home, for a skill that writes user-level files. The home seed is taken just before the prompt runs, after the login files and the skill copies are in place, so those never count as the agent's. Files are read as UTF-8 with replacement characters, and a file over 5 MB scores 0 in a pattern or line check, with the reason `file is larger than the 5 MB pattern cap`. A failing check names the paths it is about, ten at most and then a count. The run record keeps `changedFiles`, with the created, modified and deleted paths of the workspace.

```json
{ "type": "file_lacks", "path": "src/**/*.ts", "pattern": "\\bas any\\b" }
```

```json
{
  "type": "files_changed_only",
  "allow": ["src/**", "docs/**"],
  "ignore": ["**/*.log"]
}
```

A link in a case's `workspace/` folder whose target is absolute, or leads outside the folder, is a load error that names it, because the copy keeps links as they are and the agent could write into the case through it. A link that stays inside the folder is kept as a relative link.

The full cases are in `examples/cases/file-state`.

## Setup, fixtures and home

A case that needs a git repository, a branch, a commit history, a linked worktree, a local remote or a user-level file cannot be a plain copy of files: a nested `.git` cannot be committed in your repository. Three keys build the start of a run.

```json
{
  "setup": [
    {
      "git": { "init": true, "branch": "main", "commitAll": "initial import" }
    },
    {
      "run": "bash \"$SKILL_EVALS_FIXTURE_DIR/build-history.sh\"",
      "timeoutSeconds": 60
    }
  ],
  "checks": [
    {
      "type": "command",
      "run": "git rev-list --count main..HEAD",
      "stdoutMatches": "^[1-4]$"
    }
  ]
}
```

`setup` is a non-empty list of steps. They run in order, each one finished before the next starts, in the workspace, after its files are copied and before the harness starts. A step is one of:

- `{ "run": "<shell text>", "timeoutSeconds": 60 }`: run with `/bin/sh -c`. The time limit defaults to 60 seconds.
- `{ "git": { ... } }`: a shortcut that expands, in this order, to `git init -q -b <branch>` (when `init` is true; `branch` defaults to `main` and needs `init`), `git add -A && git commit -q -m <commitAll>` (when `commitAll` is set), and for `remote` a bare repository in the remote directory, added as that remote and pushed to: `git init -q --bare "$SKILL_EVALS_REMOTE_DIR/<remote>.git" && git remote add <remote> ... && git push -q -u <remote> HEAD`. A `commitAll` needs at least one file in the workspace, as `git commit` does.

Steps get the environment of a `command` check, plus `SKILL_EVALS_REMOTE_DIR`, `SKILL_EVALS_FIXTURE_DIR` and the case's `env`. They never get `SKILL_EVALS_GRADER_DIR` or `SKILL_EVALS_SEED_DIR`, a provider key or the harness's login files. Git reads none of your configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), never refreshes an index it does not own (`GIT_OPTIONAL_LOCKS=0`), and never looks for a repository above the workspace's parent directory (`GIT_CEILING_DIRECTORIES`), so a setup commit does not depend on your `~/.gitconfig` and is never signed. Setup commits as `Developer <developer@example.com>`, so nothing in the history says the repository was built. A case's `env` may set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `GIT_COMMITTER_DATE`; they reach setup, the agent and the commands alike, which also lets a real agent commit. A history script should spread its commits over time by setting both date variables on each commit, because commits made in one second are a sign that a script made them. To let the agent commit under a name without touching `env`, seed a `.gitconfig` with `home`. A step that fails (a non-zero exit, a time limit, a start that did not work) stops setup, the harness never starts, and the run is invalid with `setup failed: step <n> (<first 40 characters of the command, on one line>): <why>`. A failed setup is never a score of 0.

The seed that file checks and `$SKILL_EVALS_SEED_DIR` compare against is taken after the steps, so it describes the workspace the agent starts from, `.git` included. Git writes inside `.git` whenever the agent runs a command, so `changedFiles` for a git case lists those paths. Leave them out with `ignore`, for example `{ "type": "files_changed_only", "allow": ["src/**"], "ignore": [".git/**"] }`.

**`fixture/`.** A `fixture/` folder beside `prompt.md` holds what setup needs and the agent must not see, such as the script that builds a history. It is not copied into the workspace. It is copied to a temp directory outside the workspace, `SKILL_EVALS_FIXTURE_DIR` names it for the steps only, and it is removed when setup is done. A `git` step therefore cannot record it, and the agent cannot find how the repository was built. Use `bash "$SKILL_EVALS_FIXTURE_DIR/build-history.sh"`, not `bash fixture/build-history.sh`. A `fixture/` that is not a directory, or that holds a link which leaves it, is a load error, so a file called `fixture` in a 0.0.1 case folder stops loading.

**Remote and worktrees.** `SKILL_EVALS_REMOTE_DIR` is a new temp directory for this run, outside the workspace, made before setup and kept until the run's checks have finished. A bare remote goes there (the `remote` key does it), and so does every linked worktree: `git worktree add "$SKILL_EVALS_REMOTE_DIR/wt-1" -b wt-1`. A `command` check gets the same variable. A step that writes somewhere else is not stopped: setup runs as you, and [Safety](../safety.md) says what that means.

**`home`.** The name of a folder of the case, such as `"home"`. Its files are copied into the run's throwaway home after the login files and the skill copies the harness places, and before the home seed is taken, so they count as the starting state and `root: "home"` checks see them. Use it for a user-level role file, a user-level skill or a seeded configuration file. A file in it at the path of any harness's login file (`.claude/.credentials.json`, `.codex/auth.json`, and so on) is a load error. A file that would replace one the harness or its adapter already wrote, such as a skill copy it placed or OpenCode's configuration, makes the run invalid with `home/ would replace <path>`. Full cases are in `examples/cases/setup-home`.

**`fixtures`.** A list of folders, relative to the case's folder and inside the cases folder, copied into the workspace in order, before the case's own `workspace/`. A file in a later layer replaces the same path in an earlier one. Many cases can share one fixture repository with a different prompt each:

```jsonc
{
  "fixtures": ["../_shared/shop-core"],
  "checks": [{ "type": "file_exists", "path": "package.json" }],
}
```

A folder whose name starts with `_` is never a case, so keep shared fixtures under `_shared/`. A path that leaves the cases folder, or does not exist, is a load error. So is a `fixtures` or `home` folder that is a case folder, holds one, or is or sits inside any case's `grader/` or `fixture/` folder: it would hand the agent held-out files. A case folder here is what discovery treats as a case: a folder with `case.json` or `prompt.md` that has no `_`-prefixed folder on its path and no case above it. A `prompt.md` or `case.json` that is data in a `_shared/` fixture is fine. So is a whole case-shaped folder, `grader/` included, under a `_`-prefixed folder of a fixture: discovery never treats it as a case. The full case is in `examples/cases/shared-fixture`.

**Links.** `workspace/`, each shared fixture folder, `fixture/` and `home/` are copied with their links unchanged. A link whose target is absolute, or leaves its own folder, is a load error that names it.

A `tool_not_called` check with `inputMatches` reads the whole input of a call. To forbid a bare force push, use `\\bpush\\b(?!.*--force-with-lease)(?=.*(\\s-[a-zA-Z]*f[a-zA-Z]*(?=[\\s"]|$)|\\s--force(?=[\\s"]|$)|\\s\\+\\S))` (as written in JSON). It cannot tell two commands of one call apart, so `git push --force-with-lease && git push -f` in a single call is not flagged. Target case 5 in `test/target/cases/history-clean-up` uses it.

The full case is in `examples/cases/setup-git`.

## Commands after the run

A `command` check runs a shell command in the workspace after the agent exits, and scores it. Use it for what a pattern cannot say: the project's own tests, a check the agent never saw, a `git` query, or a mutation check.

```json
{
  "type": "command",
  "run": "node \"$SKILL_EVALS_GRADER_DIR/held-out.mjs\"",
  "expectExit": 0,
  "stdoutMatches": "^ok ",
  "timeoutSeconds": 120,
  "weight": 3
}
```

The command runs with `/bin/sh -c`, in the workspace, in its own process group. The check scores 1 when the exit code is `expectExit` (default 0) and standard output matches `stdoutMatches` and does not match `stdoutLacks`, and 0 when it does not. With `"scoreFrom": "stdout"` the check scores the number on the last non-empty line of standard output, which must be from 0 to 1; any other last line scores 0 and the reason quotes it. The exit code and the patterns must hold either way. A mutation ratio is a good use: the grader prints `0.75` when it caught three of four bad changes.

Every check that is not a command (file checks, tool checks, judged and decision checks) is scored first, from what the agent left, and then the command checks run one after the other in case order, so a later command sees what an earlier one did and no command can change what another kind of check reads. The record keeps the checks in the case's order. Before the first command runs, the harness's login files are removed from the throwaway home, so `$HOME` holds no credentials. A command that times out, or cannot be started, scores 0 with the reason (`timed out after 1 s` and the end of its standard error, `could not start: ...`), and the run stays valid. Whatever the command left running in the background is killed with its process group; a process that left the group (`setsid`, a detached spawn) can outlive the run, but it cannot hold the check: a short time after the command exits or times out, its pipes are let go. At most 5 MB of each of standard output and standard error is kept. A command that prints more is cut, the patterns see the kept start, and the reason says so. A pattern that throws (a regular expression that overflows the stack, for example) scores its check 0 with `the check could not be scored: <message>`, and the run stays valid. A command check runs only when the run is valid so far: after a harness error or a time limit, it is not run, scores nothing, and the run is invalid for its first reason.

The run record keeps the command, its exit code, its duration, and the last 2,000 bytes of each stream, and whether the output was cut, as `command` on the check. The reason is `exit <n> in <ms> ms`, and on a failure it ends with the end of standard error.

A `grader/` folder beside `prompt.md` holds files that only the command may read. It is not copied into the workspace before the agent runs. After the agent exits it is copied into a new temp directory with a plain name, and `SKILL_EVALS_GRADER_DIR` names it. The copy is removed with the run's other temp directories. A `grader/` folder inside `workspace/` is a load error, because the agent would start with the held-out files.

The command gets exactly these variables, and the ones in the case's `env`, and nothing else from your shell. It never gets a provider key.

| Variable                                                      | Value                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH`, `TMPDIR`, `LANG`                                      | Taken from the environment of the command that runs `skill-evals`.                                                                                                                                                                                                                                  |
| `HOME`, `SKILL_EVALS_HOME`                                    | The run's throwaway home.                                                                                                                                                                                                                                                                           |
| `SKILL_EVALS_WORKSPACE`                                       | The workspace, as the agent left it.                                                                                                                                                                                                                                                                |
| `SKILL_EVALS_GRADER_DIR`                                      | The copy of `grader/`. Not set when the case has none.                                                                                                                                                                                                                                              |
| `SKILL_EVALS_SEED_DIR`                                        | A read-only copy of the workspace as the agent started from it, setup included (a `.git` that setup made is in it). Taken only when the case has a `command` check, and checked against the seed before each command: a change to it scores that check 0 with `the seed copy was changed: <paths>`. |
| `SKILL_EVALS_REMOTE_DIR`                                      | The run's directory outside the workspace, the one setup used for bare remotes and linked worktrees. It exists until the run's checks finish.                                                                                                                                                       |
| `SKILL_EVALS_TRANSCRIPT`                                      | Not set yet.                                                                                                                                                                                                                                                                                        |
| `GIT_OPTIONAL_LOCKS`, `GIT_CEILING_DIRECTORIES`               | `0`, and the workspace's parent directory, so git never rewrites a read-only seed or finds a repository around the workspace.                                                                                                                                                                       |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`                    | `/dev/null` and `1`, so no git setting of yours applies.                                                                                                                                                                                                                                            |
| `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` and the two `_EMAIL`s | `fixture`, and `fixture@example.invalid`.                                                                                                                                                                                                                                                           |

A mutation check applies a known-bad change and expects the agent's own check to catch it. Do not write `! npm run lint`: it also passes when there is no lint script at all. Expect the failing exit code and the rule's own message instead, so that only a lint that sees the bad change passes:

```json
{
  "type": "command",
  "run": "git apply \"$SKILL_EVALS_GRADER_DIR/bad.patch\" && npm run lint --silent",
  "expectExit": 1,
  "stdoutMatches": "no-var"
}
```

Commands run as you, without a sandbox. [Safety](../safety.md) says what that means. The full case is in `examples/cases/command`.

## Checks that a model scores

Use a `judge` check or a `decision` check for a quality that no pattern can find. [Judged checks](judged-checks.md) and [Decision checks](decision-checks.md) say how each is scored and configured.
