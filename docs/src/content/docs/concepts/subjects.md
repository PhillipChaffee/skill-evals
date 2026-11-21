---
title: Subjects
description: What a run loads, which is a plugin, a folder of skills, or nothing.
---

A subject is what a run loads into the harness. You name it with `--subject`, `--a`, or `--b`.

| You pass                                                             | Kind     | What the run loads                                                                                        |
| -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| A directory, or a git ref of the project, that has a plugin manifest | `plugin` | The directory, the way each harness loads a local plugin. Hooks and rules that the plugin ships load too. |
| Any other directory or git ref                                       | `skills` | Each skill in it, copied to the place where the harness discovers a user's skills.                        |
| `none`                                                               | `none`   | Nothing. This is the baseline for "does the skill change anything".                                       |

- **Project.** The project is the git repository that holds the working directory, or the working directory itself when it is not in a repository. The default subject is the project folder, with its uncommitted changes.
- **Directory.** A directory is copied as it is on disk, uncommitted changes included. A relative path resolves against the working directory. For a folder that is named `none`, write `./none`.
- **Git ref.** Anything that is not a directory must be a git ref of the project. It is exported with `git archive` and `tar`, so a path that `.gitattributes` marks `export-ignore` is left out. There is no worktree. The report prints the commit, so a stale local `main` is visible. A missing `tar` is a usage error.
- **Plugin manifest.** A directory is a plugin when its root has `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin.json`, `.opencode/plugins/`, or a `package.json` with a `pi` key. A plugin loads only in the harnesses it has packaging for.
- **Skills folder.** The skills are every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and `<dir>/SKILL.md` itself, which is one skill named after the folder. The name of a skill is the name of its folder, and the `name` in its front matter must be the same. A folder with no skill is an error.

## A run never loads the subject in place

Once per command, each subject is exported to a temp directory. Each run then gets its own copy of that export, in a `kit-*` directory, and the harness loads the copy. Nothing in the agent's view names the tool or says why the directory exists. The export and the copies are removed when they are no longer needed, on failure and on Ctrl+C too.

The export always leaves out:

- `.git` and `node_modules`, at any depth.
- The cases directory, when it is inside the subject. A project that keeps its cases in `evals/cases` does not show them to the agent.
- The output directory, when it is inside the subject.
- Every glob in the `subjectExclude` key of the [config file](../reference/config.md). `*` matches within one directory, `**` matches any depth, `?` matches one character, and `{a,b}` matches either. A glob matches a whole path relative to the subject, and a directory that matches goes with everything in it.

A link in the subject that points outside it is a load error, because a link would let the agent read a file the export left out. A link with an absolute target counts as outside. Links that stay inside the subject are kept as links.

What the agent edits in its copy never reaches the source, or the next run. The tool hashes the copy before and after each run. The run record keeps `subjectMutated`, and `subjectChanges` with the created, modified, and deleted paths. The check `subject_unchanged` scores 1 when the agent changed nothing:

```json
{ "type": "subject_unchanged" }
```

The tool also hashes the source directory, with the same exclusions, before the first run and after the last one. When it differs, the command prints `the subject directory changed during the run` with the paths, and exits 1. A git ref has no source directory to hash, because a commit cannot change.

A hook or script in the subject that depends on its absolute path, or on `.git`, sees the copy and not the source. A hook that finds its files relative to the plugin root works. A copy of a large subject takes disk space and time for each run.

Where a `skills` subject goes, inside the run's own home directory:

| Harness       | Location                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/skills/<name>/`                                                                              |
| `cursor`      | `~/.cursor/skills/<name>/`                                                                              |
| `codex`       | `~/.agents/skills/<name>/`                                                                              |
| `opencode`    | `~/.agents/skills/<name>/`                                                                              |
| `pi`          | `~/.pi/agent/skills/<name>/`, each named with `--skill` because the run switches Pi's own discovery off |

The files are copied, not linked, from the run's copy of the subject, so every path that the export leaves out is also missing here. A skill of the same name that you installed globally does not load, because your real home directory is not the run's home.

With `none`, and with every other subject, the harness still loads what it ships with. Some harnesses also fetch plugins that your organization manages. Claude Code did that in the runs behind this document.
