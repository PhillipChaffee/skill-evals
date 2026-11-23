---
title: Migrate from 0.0.1
description: What changes for a suite written for 0.0.1, and what stays unproven on real harnesses.
---

A suite written for 0.0.1 still loads in 0.1.0, and most of its scores do not move. Eight changes can make a command fail or a score change. Read them first. Items 2, 3, 7 and 8 change what a 0.0.1 suite scores; the others make a command fail or exit with a different code.

## What you must check

1. **An unknown key in a `case.json` is an error.** 0.0.1 ignored it. Now the load fails and names the key and the keys that are allowed. Keys that start with `x-` are kept. To get the old behavior for one release, run with `--lenient` (or set `lenient` in the config file): the unknown key is dropped with a warning. After that release, remove or fix the key.
2. **The rule for a skill load changed.** 0.0.1 counted any tool input that mentioned `skills/<name>/SKILL.md`, so a `grep` across the skills or a fixture in the workspace scored as a load. Now `skill_loaded` counts a skill-tool call, a read of the subject's own `SKILL.md`, or a shell command that reads it, and nothing else. A suite that leaned on the old rule can score lower. `--lenient` keeps the old rule for one release, for a `skill_loaded` or `skill_not_loaded` with neither `via` nor `resolved`.
3. **A `path` with `*`, `?` or `{` is a glob.** In a file check, such a path used to name one file. Now `*` and `?` match within a directory, `**` matches across directories, and `{a,b}` picks one of two. A file whose real name holds one of these characters needs a different check or a renamed file.
4. **An invalid run exits 3.** 0.0.1 exited 1, the code of a missed bar. A pipeline that tests for 1 must also test for 3, or pass `--max-invalid <fraction>` to tolerate a share of invalid runs. [Exit codes](../reference/exit-codes.md) lists every code.
5. **The harness gets an allowlisted environment.** It no longer gets a copy of yours. It gets `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, the proxy and certificate variables, its own adapter's login variables, and the names you list in the `env` config key. Its `TMPDIR` is a new directory of the run's own, not yours. If a harness needs another variable, add its name to `env`. The judge gets the same environment.
6. **A `--b` plugin subject is loaded from a copy.** Every run copies the subject (a directory, or a git ref exported with `git archive`), so an agent's edits never reach your checkout or the next run. The copy leaves out `.git`, `node_modules`, the cases directory and the output directory. A hook that depends on its absolute path or on `.git` sees the copy instead. Add globs to `subjectExclude` to leave out more.
7. **A check of kind `subagent` needs a harness that reports subagents.** A tool check or matcher of kind `subagent` needs the capability `subagents`, so on Pi such a case is "not applicable". In 0.0.1, `tool_not_called` with `kind: "subagent"` passed there, because Pi never shows a subagent call. The new kinds `question` and `mcp` need `askUser` and `mcp` in the same way.
8. **A matcher of kind `other` with a `name` no longer matches `AskUserQuestion`.** In 0.0.1, `AskUserQuestion` and every MCP tool had kind `other`. Now they have the kinds `question` and `mcp`. A matcher of kind `other` with no `name` still matches both. With a `name`, it matches an MCP call whose native name (`mcp__server__tool`) fits, and it never matches a question call. Write `kind: "question"` for a question call.

## Also changed

These do not need a change in most suites. The [changelog](../project/changelog.md) has the full text of each.

- Exit codes 4 (a cost or time budget stopped the command), 5 (an internal failure) and 130 (interrupted).
- Claude Code's `AskUserQuestion` maps to the new tool kind `question`, and MCP tools map to `mcp` (see items 7 and 8).
- `min: 0` with no `max` on `tool_called` and `hook_fired` is a load error, because it passes every run.
- Numeric flags such as `--reps` and `--jobs` read a decimal literal only.
- `run`, `score` and `calibrate` ask before they run a cases directory they have not seen, and exit 2 without a terminal unless you pass `--yes`.
- Blinding lint: a word that hints at a test is a warning in `validate`, and a hard error in a few places. A missing `why` in `x-unblinded` is a load error, and `run` and `score` exit 2 when the temp directory or an environment variable name holds such a word.
- `--sandbox` runs each harness process in `bwrap` or `sandbox-exec`.
- With no `--out`, results go to `runs/<time>-<random>` in the state directory, not to a new directory in the system's temp directory.

## Not yet confirmed on real harnesses

An adapter declares a capability only when a test proves it on a stream. A case that needs a capability the harness does not declare is reported "not applicable", never a pass and never a zero. These capabilities stay undeclared until a real model has shown them. [Capabilities](../concepts/capabilities.md) has the table.

- `userInvoke` (a slash command that starts a skill): no harness declares it.
- `compact` (compacting the conversation between turns): no harness declares it.
- `historyNative` (a conversation written into the harness's own session store and resumed from it): no harness declares it.
- `sessionStore` (sessions in files that a run can read after it ends): no harness declares it.
- `rulesReport` (the harness reports the rule texts it loaded): no harness declares it, so a case that needs it does not apply on Claude Code today.
- Codex, Cursor, OpenCode and Pi: every capability beyond what a fixture shows. Codex, OpenCode and Pi ran through a scripted endpoint and no real model. Cursor stopped at its login check. [What was verified](../agents/verified.md) says how each adapter was proven.
