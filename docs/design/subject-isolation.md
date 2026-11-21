# Subject isolation

## Decision

A subject is never loaded in place. There is no in-place mode.

Once per command, the subject is exported to a temp directory:

- A directory subject is copied. Links are kept as links.
- A git-ref subject is exported with `git archive`, so `export-ignore` paths are left out. There is no worktree.

The export always leaves out `.git`, `node_modules`, the cases directory when it is inside the subject, the output directory when it is inside the subject, and every glob in the config key `subjectExclude`.

A link in the subject that points outside it is a load error.

Each run gets its own fresh copy of the export, in a `kit-*` temp directory. The harness loads that copy. One run's edits never reach the next run or the source.

The copy is hashed before and after the run. The record keeps `subjectMutated` and `subjectChanges` with the created, modified and deleted paths. The check `subject_unchanged` scores 1 when nothing changed.

The source directory is hashed before the first run and after the last. A difference is a hard error at the end of the command.

### `--isolated`

`--isolated` starts the harness with nothing but the subject. It is opt-in in this release, and the CI guide recommends it.

Each adapter that declares the `isolated` capability turns off user-level, organization-level and project-level plugins, skills, rules, hooks, MCP servers and memory. An adapter that cannot do it does not declare the capability, and `--isolated` with that harness is a usage error.

Flags are never trusted. The record keeps what the harness reported as loaded. Under `--isolated`, anything in that report that is not the subject or one of the adapter's listed built-ins makes the run invalid, and the reason names it.

### Environment

The harness process gets an allowlisted environment: path, locale, proxy and certificate variables, the adapter's own auth variables, and the names in the config key `env`. Everything else is dropped.

## Why

Three leaks existed in 0.0.1:

1. A consumer that commits its cases inside the subject repository let the agent read every prompt and rubric.
2. A skill that edits the kit could change the consumer's checkout during a run.
3. The `none` baseline was not empty on a machine with organization-managed plugins.

Copying fixes the first two for every harness at once, with no adapter work. A copy is cheap next to a model run.

Proof from the harness's own report matters more than a flag. A flag can be ignored by a newer CLI version. A report of what loaded cannot be argued with.

## Alternatives rejected

- **Loading in place with a read-only mount.** It needs a sandbox backend on every platform, and it still exposes the cases directory.
- **One shared copy for all runs.** A kit-editing run would contaminate later runs.
- **A git worktree for a ref.** It holds the whole tree, cases included, and ignores `export-ignore`.
- **`--isolated` on by default.** A 0.0.1 suite on a machine with user-level settings would change its scores without any case change.
- **Trusting isolation flags.** Organization-managed plugins may load despite them.

## What it costs

- One copy of the subject for each run. For a large kit this is disk and time, though small beside the run.
- A hook or script in the subject that depends on its absolute path, or on `.git`, sees a different place.
- On Claude Code, organization-managed plugins may not be suppressible. `--isolated` then marks those runs invalid instead of making the baseline empty. The fix is an unmanaged runner.
- A harness that needs an environment variable outside the allowlist needs it named in `env`.
