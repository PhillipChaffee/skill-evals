# Rules, hooks and preconditions

## Decision

- **Rules.** The config keys `rules` (a directory of the subject) and `instructionFile` (a file of the subject) name a subject's rules. Both are checked against the subject's export: a path that is absolute or climbs out with `..`, a link, a missing path, and a link inside the rules directory are usage errors. The `none` subject has no rules. An adapter implements `rulesTargets(files)` (a pure map from each file to a place under the run's home or workspace) and `installRules(files, input)` (the copy, which never overwrites). It declares the capability `rules` only where the mechanism is confirmed.
- **The record.** `RunRecord.rules` is `{ installed, reportedLoaded }`. `installed` is where the adapter put each file, relative to the run's home or workspace, and empty for a harness without `installRules`. `reportedLoaded` is `Parsed.loaded.rules`, null when the harness reports nothing. The key is absent when the subject names no rules.
- **A clash is a load error.** Before any run, a rule whose place already has a file in a case's shared fixtures, `workspace/` or `home/` stops the command with a usage error that names both. A step of `setup` can still create the file at run time; the install then fails and the run is invalid.
- **Hooks.** A transcript event of type `hook` has `hook: { event, command, exit, contextBytes, context }`. `context` is cut at 4,000 characters, with a line saying how much was kept, and `contextBytes` keeps the original size. A field the stream does not carry is null. `callsOf` reads `tool_call` events only, so a hook event is never a tool call.
- **Checks.** `hook_fired { event, min, max }`: `min` is 1, or 0 when `max` is 0. `context_injected { pattern, flags, source }`: it reads the contexts of hook events and `Loaded.ruleTexts` (the rule and instruction text that the harness reports). It never reads a file that the run installed: that would make every precondition true.
- **Needs.** `hook_fired` needs `hooks`. `context_injected` with `source` `hooks` needs `hooks`, with `rules` needs `rules`, and with `any` (the default) needs one of them (`Spec.needsAny`). With neither, the case is not applicable.
- **Preconditions.** A case key `preconditions` takes checks of the types whose spec says `precondition: true`: `context_injected`, `hook_fired`, `skill_available`, `skill_loaded`. Any other type is a load error. They are scored first. One that scores 0, or has no score, makes the run invalid with `precondition not met: <describeCheck>`, and the judged, decision and command checks of that run are left unscored with that reason, so the judge and the decision model are never asked. A precondition never counts in the run score, and it is recorded in `RunRecord.preconditions`. Its needs make the case not applicable, and `ifUnsupported` does not skip it.

## Evidence

Read from the installed binary, `claude` 2.1.330 (`/opt/claude-code/bin/claude`), with `--help` and `grep -a`. No model was run.

### Claude Code: confirmed

- `--include-hook-events`: "Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)" in `claude --help`. The adapter passes it.
- The stream schema, from the binary's embedded zod definitions: `{ type: "system", subtype: "hook_started", hook_id, hook_name, hook_event }`, `{ ..., subtype: "hook_progress", hook_id, hook_name, hook_event, stdout, stderr, output }` and `{ ..., subtype: "hook_response", hook_id, hook_name, hook_event, output, stdout, stderr, exit_code?, outcome: "success" | "error" | "cancelled" }`. The adapter makes one hook event of each `hook_response`.
- A hook's JSON output has `hookSpecificOutput.additionalContext`, "delivered to the model". The adapter takes that text as the context when the standard output is such JSON, and the standard output otherwise.
- User rules: the binary has a function that returns `join(<config dir>, "rules")`, and the user memory file is `join(<config dir>, "CLAUDE.md")`. The project's rules directory, `<project>/.claude/rules`, is gated by the `project` setting source, which `--isolated` turns off (`--setting-sources user`). The config directory is `CLAUDE_CONFIG_DIR` (`process.env.CLAUDE_CONFIG_DIR || ~/.claude`). So the adapter installs into the run's home, where the `user` source is, and the rules load with and without `--isolated`, and the workspace holds no extra file.

### Claude Code: not confirmed

- That a rules file under `<config dir>/rules` is read in a `-p` process by a real model. The function that names the directory was read, not run.
- That `<config dir>` for rules is the same directory as `CLAUDE_CONFIG_DIR` in every case: the binary's name for it is minified, so the link between the two was read from the shape of the code, not proven.
- What the `output` and `stdout` fields of a `hook_response` hold apart. The adapter prefers `stdout`.
- That the hook's context is what reaches the model. The stream states what the hook wrote, not what was sent.
- The hook's command. The stream has `hook_name`, not the command, so `command` is null.
- Any report of loaded rules. The init event lists none, and the `InstructionsLoaded` hook event exists but needs a hook configured, which this adapter does not do. So `reportedLoaded` is always null for Claude Code, and `context_injected` with `source: "rules"` can never hold on it. A case about a rule that must reach the model needs a hook that injects the rule, or a harness that reports its rules. The tests use a test-only harness (`src/testing/rules.ts`) that reads a `rules_loaded` event of the fake harness.

### Other adapters

Codex, Cursor, OpenCode and Pi are not installed here. None declares `rules` or `hooks`: the file layout and the stream events are unconfirmed.
