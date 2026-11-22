# Multi-turn cases and history

## Decision

### Turns

A case may list `turns`. Each turn is one of:

- `{ "prompt": "<file>" }`: a user message.
- `{ "invoke": { "skill", "args" } }`: a user invocation of a skill, mapped by the adapter to the harness's own syntax.
- `{ "event": "compact" | "clear" | "resume" }`: a lifecycle event.
- `{ "reply": { "whenAsked": "<regex>", "prompt": "<file>" } }`: sent only when the previous turn ended awaiting the user and the question matches. Otherwise the turn is skipped and recorded as such.

`prompt.md` alone is one turn. `prompt.md` together with `turns` is a load error.

Each turn is one harness process. The adapter continues the session by its own means and declares `multiTurn` only when it can. `RunInput.session` is the previous turn's `Parsed.sessionId`; a turn that states none ends the run as invalid (`turn N gave no session id to continue`).

An `invoke` turn reaches the adapter as the text of `Harness.userInvocation`. An `event` turn is carried out by the runner for `resume` (recorded only) and `clear` (the session id is dropped), and by a harness process for `compact`; each is an event of kind `lifecycle` in the transcript, with the event's name.

Case-level checks see the whole session. A turn's own checks see that turn's slice of the transcript, its tool calls and its final text. `file_changed`, `file_unchanged` and `files_changed_only` on a turn use that turn's changed paths, from a hash snapshot taken after each turn (`RunRecord.turnChanges`). No files are copied for this. Every other file check and every `command` check on a turn sees the final workspace. A turn's checks may not be `judge` or `decision` checks, or file-change checks on the home. A turn that was not sent because the run was stopped scores its checks 0 with a reason.

Tokens and cost are summed across turns. `timeoutSeconds` applies to each turn. The overall cap is `timeoutSeconds` times the number of turns, unless `totalTimeoutSeconds` is set.

### Turn limit

The runner counts assistant turns in the stream as it arrives and stops the process group at `maxTurns`. The harness's native flag is also passed where one exists. Hitting the limit scores the run, with `stoppedBy: "maxTurns"`. A harness without turn grouping records `maxTurnsEnforced: false`, and the report says so. The case still runs, as it does in 0.0.1.

### History

`history.json` is an ordered list of `{ role, text, toolCalls? }`. There are two modes:

- `native`: the adapter writes a session into the harness's own store and resumes it. The seeded session is the active session on disk, with assistant turns and tool results intact.
- `preamble`: the history is rendered as a clearly delimited quoted block in front of turn 1.

`history` is the capability for the preamble, and every adapter declares it, because the runner writes the block itself. `historyNative` is its own capability, so a case can require it. The default mode is `preamble` for every adapter until Task 29 confirms a native store, and an adapter may name its own default with `Harness.historyMode`. `RunRecord.historyMode` is `native`, `preamble` or null (no history). `--history-mode native|preamble` (config key `historyMode`) forces a mode. Forcing `native` on an adapter without `historyNative` makes a case with a history not applicable, with the reason; it is not a usage error. A case that requires `historyNative` is not applicable under `preamble`, whether it is the default or forced; so is a case whose first turn is an `invoke`, because a block in front of a slash command would stop it being one.

The preamble is headed `Earlier in this conversation (<n> messages):`, fenced with more backticks than any run of backticks in the history so that the history cannot close the fence, and followed by `Latest message:`. It names no eval, case or tool of this package.

The seeded history is not in the transcript. The transcript file (and `SKILL_EVALS_TRANSCRIPT`) holds the agent's events only, numbered from 0 as the reasons of the checks quote them; the messages are in `<stem>.history.json`, which a `command` check gets as `SKILL_EVALS_HISTORY`. History is excluded from every check: tools, order, first, transcript, skills, output, dispatch and asked, and from the record's `toolCalls` and `skillsLoaded`. `show` prints the agent's events at their own index and the history as `h0`, `h1`, … with the role. The judge sees no history in this release; its task text is the case's prompt without the block. There is no opt-in. (An earlier draft put history events first in the transcript with `userTurn: -1`; that renumbered the agent's events and fed them to command graders, so it was dropped.)

Order of planting in a run: setup steps, login files, history and sessions, then the harness. Planted files are in the home as the harness's prompt finds it (`homeSeed`), so a check on the home does not see them as the agent's changes, and an archive treats them like other home files, with the login files still left out. The case's `home/` layer is copied after planting, and its clash check covers the planted files too. A `sessions.json` `cwd` is relative and resolves against the workspace's real path; an absolute one, or one that leaves the workspace, is a load error, because the path is written into a file the agent can read. The active session is dated an hour after the latest earlier session. The adapter refuses to plant through a symlink.

### Session store

`sessions/sessions.json` plants other past sessions in the harness's prior-session store. This is separate from history. A harness with no such store lacks `sessionStore`, and the case is not applicable there.

## Native history and session stores (Task 25, unconfirmed)

Claude Code declares neither `historyNative` nor `sessionStore`. `src/harnesses/claude-code-history.ts` writes the files, and the tests use a test-only harness (`src/testing/native-history.ts`, never exported) that declares both. The format and the location below were read from the strings of the installed binary with `grep -a` on `/opt/claude-code/bin/claude` (`claude --version` 2.1.330). No model ran, so no real Claude Code has been shown to accept a planted session. Task 29 confirms it, or fixes the format, and then declares the capabilities.

| What              | Derived value                                                                                                                                                                                                                   | Evidence in the binary                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store             | `<CLAUDE_CONFIG_DIR>/projects/<name>/<session id>.jsonl`. The run's `CLAUDE_CONFIG_DIR` is `<home>/.claude`.                                                                                                                    | `function vm(){return S(et(),"projects")}`, `function $A(e,n=vm()){return S(n,nO(e))}`, and the lookup ``S($A(o),`${e}.jsonl`)``.                                                                                                                                                        |
| Directory name    | The working directory (real path) with every character that is not a letter or a digit replaced by `-`. Past 200 characters: the first 200, `-`, and the absolute value of Java's string hash `(h << 5) - h + code` in base 36. | `function KN(e){let n=w(e);if(n.length<=_oe)return n;return`${n.slice(0,_oe)}-${ge(e)}`}`, `w(e)=e.replace(/[^a-zA-Z0-9]/g,"-")`, `_oe=200`, and `Math.abs(rse(t)).toString(36)` with `rse` that hash.                                                                                   |
| Line              | One JSON object per line: `parentUuid` (the line before; null for the first), `isSidechain: false`, `userType`, `cwd`, `sessionId`, `version`, `type` (`user` or `assistant`), `message`, `uuid`, `timestamp`.                  | The writer builds `{parentUuid, isSidechain, ...message, ...zts(sessionId), version, gitBranch, slug}`; `zts` gives `{sessionKind, userType, entrypoint, cwd, sessionId, version}`; the schema of a user line has `type: "user"`, `timestamp`, `message: { content }` and `isSidechain`. |
| Assistant message | `{ id, type: "message", role: "assistant", model: "<synthetic>", content: [text and tool_use blocks], stop_reason, usage }`. A message of only calls has no text block.                                                         | The `<synthetic>` model constant and `stop_reason` handling in the stream code.                                                                                                                                                                                                          |
| Tool result       | The next `user` line, with `content: [{ type: "tool_result", tool_use_id, content }]`. A call without an output gets `content: ""`, because the API refuses a call with no result.                                              | `{type:"tool_result",tool_use_id:E.id,content:k}` in the tool runner.                                                                                                                                                                                                                    |
| Resume            | `--resume <session id>`, with an id that is a UUID. The adapter writes a UUID that depends only on the history (a version 4 shaped hash), so the same history is the same session.                                              | `claude --help`: `-r, --resume [value]  Resume a conversation by session ID or name`; the lookup above reads `<id>.jsonl`.                                                                                                                                                               |

Two more facts. `CLAUDE_CODE_PROJECT_DIR_NAME` changes the name of the project directory (the binary's `nO(e)` is `m5n() ?? KN(e)`), so a run never gets it: it is dropped from the harness's environment even when the config's `env` names it. And session ids that are not UUIDs are unverified: the binary has an `invalid-resume-id.jsonl` path for an id it rejects, so `--resume` may refuse the id of a `sessions.json` entry that is not a UUID, though the active history session always has one.

What this does not prove: that Claude Code reads a line without the fields this table does not list, that it accepts `<synthetic>` as the model of a resumed assistant line, that the directory name is computed from the real path of the working directory on every platform, and that the session list (`sessionStore`) finds a file in a project directory that Claude Code did not create. The session-index files that the binary may also keep were not read.

## Why

Nine of the consumer's skills work on earlier conversation, and pressure cases need a follow-up push. One prompt and one turn cannot express either.

One process for each turn works with every CLI that can continue a session, and it keeps the stream of each turn separate, which makes per-turn slices exact.

Some skills are wrong under a preamble. A skill that restates its own previous message, or that finds the active session transcript on disk, needs real prior turns. Making `historyNative` a capability lets those cases say so and be not applicable elsewhere, instead of grading a run that could not succeed.

Conditional replies exist because several cases pass when the agent stops and asks. A fixed list of turns cannot answer a question that may not be asked.

## Alternatives rejected

- **Replaying history as real turns.** The model's replies would differ from the seeded ones, and every replay costs tokens.
- **One long-lived process fed turns on standard input.** Not every CLI has a streaming input mode, and a hang would lose the whole session.
- **Only a preamble.** It is wrong for the skills named above.
- **A workspace copy after each turn.** No case needs it. A hash manifest answers "turn 1 changed nothing under `src/`" at a fraction of the cost.
- **Treating a turn-limit hit as invalid.** Running out of turns is agent behaviour.
- **Treating a final message that ends with a question mark as asking the user.** It would misfire on rhetorical questions. Only the harness's question tool counts.

## Confirmed from the CLIs (Task 24a)

Each adapter declares a continuation, user syntax or lifecycle capability only when the CLI's own `--help` confirms the mechanism. Only Claude Code was installed when this was written (`claude --version` 2.1.330, `/opt/claude-code/bin/claude --help`, which spends no model).

| Capability   | Claude Code                                                                                                                                                                                                                                                                           | Evidence from `claude --help`                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiTurn`  | Declared. `--resume <session id>`, with the id of the turn before.                                                                                                                                                                                                                    | `-r, --resume [value]  Resume a conversation by session ID or name`; `--no-session-persistence  Don't save sessions to disk; they can't be resumed (only works with --print)`, so a `-p` session is saved and can be resumed. |
| `resume`     | Declared. The event is carried out by the runner: every later turn already resumes the session in a new process, and the event records that in the transcript.                                                                                                                        | The same flag.                                                                                                                                                                                                                |
| `clear`      | Declared. The runner forgets the session id, and the next process starts without `--resume`, so it is a new conversation in the same workspace.                                                                                                                                       | `-c, --continue  Continue the most recent conversation in the current directory` and `-r` are how a conversation continues; a `-p` process given neither starts a new one.                                                    |
| `userInvoke` | Not declared. `/<skill> <args>` is the expected syntax, but it is unconfirmed: whether a `/skill` prompt in a `-p` process loads the skill needs a real model. Task 29 confirms it, as for `compact`. Tests use a test-only harness that declares it.                                 | `--bare ... Skills still resolve via /skill-name`, and `--disable-slash-commands  Disable all skills and commands`; no run was made.                                                                                          |
| `compact`    | Not declared. The help shows `--autocompact <auto\|tokens>`, the automatic window only. `/compact` in a `-p` process is not confirmed. The stream's `compact_boundary` system event (the binary writes it) is parsed as a `lifecycle` event, so a harness that does compact shows it. | None.                                                                                                                                                                                                                         |

For Task 29 (the other adapters): none of `pi`, `opencode`, `codex` or `cursor-agent` is installed in this environment, so none declares `multiTurn`, `userInvoke`, `compact`, `clear` or `resume`. Each needs its own `--help` read for the continuation flag, its user syntax for a skill, and a compaction command, before it declares them.

## Asking the user (Task 24b)

| Capability | Claude Code                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `askUser`  | Declared. `AskUserQuestion` maps to the tool kind `question`. Its input is `{ questions: [{ question, options, ... }] }`, so the question text is the `questions[].question` texts joined with newlines. `Parsed.askedUser` is true when the result's `permission_denials` lists `AskUserQuestion`: a `-p` process cannot ask. | `grep -aoE` on `/opt/claude-code/bin/claude` shows the tool named `AskUserQuestion` and its schema `questions: A(...).min(1).max(4).describe("Questions to ask the user ...")` with a `question` field, and `permission_denials` in the result with `tool_name` entries. No run was made. |

The `permission_denials` signal is read from strings in the binary and is unconfirmed against a real stream until Task 29, which also decides `askUser` for `pi`, `opencode`, `codex` and `cursor-agent` (none installed here, so none declares it and none maps a question tool). Until a stream shows it, the `question` kind is never produced there.

## What it costs

- Each CLI's continuation flag, session store layout and lifecycle commands must be confirmed from that CLI. Until then the capability stays undeclared.
- Results under `native` and `preamble` are not comparable. The report shows the mode, and the flag forces the common one.
- Per-turn file checks see hashes, so they can say what changed in a turn, not what a file held mid-run.
- A skipped conditional turn leaves its checks unscored. The report says so.
