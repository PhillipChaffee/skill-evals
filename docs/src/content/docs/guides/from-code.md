---
title: Use it from code
description: Run an evaluation from JavaScript or TypeScript with evaluate, loadCases, and HARNESSES.
---

```js
import { evaluate, loadCases, HARNESSES } from "skill-evals";

const evaluation = await evaluate({
  cwd: "/path/to/project", // default: the working directory of the process
  subjects: ["none", "./skills"], // one subject to score, or two to compare (A, then B)
  model: "<model-id>",
  reps: 3,
  minScore: 0.8,
  onRun: (record) => console.error(record.caseId, record.score),
});
if (evaluation.belowBar.length || evaluation.invalid.length)
  process.exitCode = 1;
```

| Export                 | What it is                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate(options)`    | Does what `run` and `score` do, without the report. Unset options take their value from the [config file](../reference/config.md). |
| `loadCases(dir, glob)` | Reads and validates the cases in a directory.                                                                                      |
| `HARNESSES`            | The harness adapters, in default-preference order.                                                                                 |

Every option, every field of the result, and every exported type is in the API reference, which is generated from the doc comments in [`src/index.ts`](https://github.com/PhillipChaffee/skill-evals/blob/main/src/index.ts) and the files it exports from when the docs site is built. In the docs site its pages are next to this one in the sidebar.

In what `evaluate` resolves to, `suites` holds the case and suite scores for each harness, keyed by the subject's label (`a` and `b`, or `subject`). `belowBar` lists the pass bars that were not reached, and `invalid` lists the runs that do not count. The evaluation passed when both are empty. Everything but `cases` and `outDir` is also in `<outDir>/results.json`.

The package ships type declarations, so `evaluate`'s options and what it resolves to are typed in TypeScript.

`evaluate` prints nothing and does not end the process. A wrong option, case file, or config file rejects with an error whose `name` is `UsageError`. While it runs, SIGINT and SIGTERM end the process with exit code 130 after the temp directories, the worktrees, and the harness's processes are removed.
