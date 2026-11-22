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
process.exitCode = evaluation.exit; // the code the command line would give, from exitCodeOf
```

| Export                 | What it is                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate(options)`    | Does what `run` and `score` do, without the report. Unset options take their value from the [config file](../reference/config.md). |
| `loadCases(dir, glob)` | Reads and validates the cases in a directory and its subdirectories. `glob` selects by id and defaults to every case.              |
| `HARNESSES`            | The harness adapters, in default-preference order.                                                                                 |

Every option, every field of the result, and every exported type is in the API reference, which is generated from the doc comments in [`src/index.ts`](https://github.com/PhillipChaffee/skill-evals/blob/main/src/index.ts) and the files it exports from when the docs site is built. In the docs site its pages are next to this one in the sidebar.

In what `evaluate` resolves to, `suites` holds the case and suite scores for each harness, keyed by the subject's label (`a` and `b`, or `subject`). `belowBar` lists the pass bars that were not reached, and `invalid` lists the runs that do not count. The evaluation passed when `evaluation.exit` is 0, that is when `belowBar` and `sourceChanged` are empty, `partial` is null, and no run is invalid: a command that stopped at `maxCost` or `maxDuration` has `partial` set and `notRun` listing the runs that did not run, so its scores cover finished runs only. Everything but `cases` and `outDir` is also in `<outDir>/results.json`.

`evaluation.exit` is the exit code that `run` and `score` would give. `evaluate` returns 0, 1, 3 or 4; a failure rejects, and a signal ends the process. It comes from `exitCodeOf(results, maxInvalid)`, which the package also exports with `EXIT`, the table of codes, so that your own tooling gives the same answer as the command line. `maxInvalid` is a fraction from 0 to 1, as `--max-invalid` is; anything else, or results written before run counts existed, is a `UsageError`. `evaluation.schemaVersion` and `evaluation.meta` say how the runs were made; [Read the report](read-the-report.md#what-resultsjson-records-about-the-command) lists them. `evaluate` writes `summary.json` beside `results.json` and no other report file: the formats are the command line's. `onFinal(evaluation)` is called when `results.json` is written and before `summary.json`: write your own reports there. If it throws, both files say `error` and `evaluate` rejects.

The package ships type declarations, so `evaluate`'s options and what it resolves to are typed in TypeScript.

`evaluate` prints nothing and does not end the process. A wrong option, case file, or config file rejects with an error whose `name` is `UsageError`. While it runs, SIGINT and SIGTERM end the process with exit code 130 after the temp directories and the harness's processes are removed.
