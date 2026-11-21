# Changelog

## Unreleased

- Every run now loads a copy of the subject, never the subject itself. A directory is copied and a git ref is exported with `git archive` (so `export-ignore` applies, and there is no worktree). The copy leaves out `.git`, `node_modules`, the cases directory and the output directory when they are inside the subject, and every glob in the new `subjectExclude` config key. A link in the subject that points outside it is a load error. Each run gets a fresh copy, so one run's edits never reach the next or your checkout. The run record has `subjectMutated` and `subjectChanges`, the new check `subject_unchanged` scores 1 when the agent changed nothing, and a subject directory that changed while the command ran makes it exit 1 with the paths. Migration: a hook that depends on its absolute path or on `.git` sees the copy instead.
- The harness now starts with an allowlisted environment instead of a copy of yours. It gets `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, the proxy and certificate variables, its own adapter's login variables, and the names listed in the new `env` config key; the judge gets the same. Migration: a harness that needs a variable outside the allowlist needs it named in `env`.
- An unknown key in a `case.json` is now a load error that names the key and the keys that are allowed. Keys that start with `x-` are kept and written to `results.json`. `--lenient` (or `lenient` in the config file) drops unknown keys with a warning, for one release. Every field of a check has a type, and the reference page lists it. Validation is stricter in two small ways: a `flags` that is not valid now fails at load even when no regular expression is beside it, and when a file has several faults, an unknown-key error is reported before the others.
- The help text is written from the same tables that parse the command line. It lists the commands, then every flag once with its default and the commands that take it. No command, flag, or default changed.
- The documentation is a website next to the landing page. Its reference pages for the checks, the commands and flags, the config file, the harnesses, and the API are generated from the code, and the tests fail when a committed page or a documented example no longer matches the tool.
- Releases are guarded. `scripts/release-plan.sh` refuses a version tag that does not match `package.json`, is not on `main`, has no changelog entry, or is not above the latest version on npm, and the `Release check` workflow runs the same guards on every pull request. The publish workflow also makes the GitHub release.

## 0.0.1

The first release. The runner comes from the `evals/` folder of [magic](https://github.com/PhillipChaffee/magic), where it scored that one set of skills.

- Run it in any project. The project is the git repository that holds the working directory, and the cases default to `evals/cases` in it.
- Score a plugin, a plain folder of skills, or `none`, which loads no skills and is the baseline for a comparison.
- Set defaults in an optional `skill-evals.config.json`.
- Use it from code with `evaluate`, `loadCases`, and `HARNESSES`.
- A prompt that starts with a dash reaches the agent in every harness.
- Windows is not supported.
- The package is written in TypeScript. It ships compiled JavaScript and type declarations, and still has no dependencies.

- A `decision` check asks a decision model a question about the final answer. The case sets what each allowed answer is worth, the model returns a probability for each answer, and the check's score is the expected value. All decision checks of a case go out in one request for each run.
- `--decision-model` and `--decision-url`, and `decisionModel` and `decisionUrl` in the config file, set the model and its endpoint. The client speaks Baseten's System One API and reads its key from `BASETEN_API_KEY`. It was written from the API's documentation. It has scored checks against bison-1 on a self-hosted deployment, and has not yet called Baseten's hosted API.
- `--decision-timeout <seconds>` and `decisionTimeout` in the config file set how long one request to the decision model may take. The default stays 60 seconds. A cold start of a self-hosted model can take that long.
- A decision reply whose probabilities were rounded to 6 decimals is accepted. The sum over the allowed answers may differ from 1 by 0.0000005 for each answer, where the limit was 0.000001 in total, which rejected three honest options that added up to 0.999999.
