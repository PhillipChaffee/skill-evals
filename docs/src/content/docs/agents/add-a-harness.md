---
title: Add a harness
description: The steps to add an adapter for another coding agent.
---

Adapters live in this package. Loading one from your own code is not supported yet.

1. Add `src/harnesses/<id>.ts` whose default export has the five fields of the `Harness` type in [`src/harnesses/shared.ts`](https://github.com/PhillipChaffee/skill-evals/blob/main/src/harnesses/shared.ts): `id`, `bin`, `authFiles`, `invocation`, `parse`. Declare the stream events that `parse` reads as a type in the same file.
2. In `invocation`, load a plugin subject the way the harness loads a local plugin (`pluginDir`), copy a skills subject to where the harness discovers a user's skills (`placeSkills`), and point the harness's own config variables into `home`. Return `setup` commands when the harness has to install the plugin before it runs. When `subject` is `null`, load nothing. The judge and the `none` baseline run that way.
3. Pass the prompt so that a leading dash cannot be read as a flag: after a `--` separator, or in `stdin` when the CLI has no separator. Confirm it against the real CLI.
4. In `parse`, normalize the stream and nothing more. Return `null` for a field the harness does not report. Put only a tool call's input in `toolCalls`, never its output, or file contents will count as skill loads. Build each tool call with `toolCall` and a table from the harness's tool names to the kinds under [Tool checks](../reference/checks.md#tool-kinds). Give the adapter a `pathOf` that returns the file a `read` call targets from its input (`stringArg(call, ["path"])` when the argument is a string), or `null` for a harness with no read kind: skill-load detection reads paths only through it.
5. Add the adapter to `HARNESSES` in `src/harnesses/index.ts` at its place in the preference order.
6. Capture one real stream into `test/fixtures/` and add it to `src/adapters.test.ts`. Add the harness to the table of skill locations in `src/invocation.test.ts`, and add a row to every table in [How each harness is started](how-they-run.md) and [What was verified](verified.md) and to the table of skill locations under [Subjects](../concepts/subjects.md).
