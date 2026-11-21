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
- **Directory.** A directory is used as it is on disk. A relative path resolves against the working directory. For a folder that is named `none`, write `./none`.
- **Git ref.** Anything that is not a directory must be a git ref of the project. It is checked out into a detached worktree in a temp directory, and the worktree is removed when the command ends, on failure and on Ctrl+C too. The report prints the commit, so a stale local `main` is visible.
- **Plugin manifest.** A directory is a plugin when its root has `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin.json`, `.opencode/plugins/`, or a `package.json` with a `pi` key. A plugin loads only in the harnesses it has packaging for.
- **Skills folder.** The skills are every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and `<dir>/SKILL.md` itself, which is one skill named after the folder. The name of a skill is the name of its folder, and the `name` in its front matter must be the same. A folder with no skill is an error.

Where a `skills` subject goes, inside the run's own home directory:

| Harness       | Location                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/skills/<name>/`                                                                              |
| `cursor`      | `~/.cursor/skills/<name>/`                                                                              |
| `codex`       | `~/.agents/skills/<name>/`                                                                              |
| `opencode`    | `~/.agents/skills/<name>/`                                                                              |
| `pi`          | `~/.pi/agent/skills/<name>/`, each named with `--skill` because the run switches Pi's own discovery off |

The files are copied, not linked, and `.git` and `node_modules` are left out. A skill of the same name that you installed globally does not load, because your real home directory is not the run's home.

With `none`, and with every other subject, the harness still loads what it ships with. Some harnesses also fetch plugins that your organization manages. Claude Code did that in the runs behind this document.
