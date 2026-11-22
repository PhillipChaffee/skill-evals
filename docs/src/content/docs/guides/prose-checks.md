---
title: Check prose with text-metrics
description: Check sentence length and banned phrases in the writing an agent produces, with a grader script that you copy into a case.
---

Some skills are about how the agent writes: short sentences, no filler. A pattern cannot count words, and a model scoring them is slow and varies from run to run. `text-metrics.mjs` counts them. It is a plain `command` check, not a check type of its own: the tool stays small, and you can read and change the script.

The script is `examples/graders/text-metrics.mjs` in this package. It uses only Node, which a run needs anyway.

## Use it in a case

Copy the script into the case's `grader/` folder, which the agent never sees, and put the phrases you ban in a file beside it. Ask the agent to write the text to a file, because a `command` check reads files.

```text
evals/cases/release-notes/
  prompt.md
  case.json
  grader/
    text-metrics.mjs
    banned.txt
```

`prompt.md` asks for the notes in `notes.md`. `case.json` is:

```json
{
  "description": "The release notes are in short sentences and avoid the banned phrases.",
  "checks": [
    { "type": "file_exists", "path": "notes.md" },
    {
      "type": "command",
      "run": "node \"$SKILL_EVALS_GRADER_DIR/text-metrics.mjs\" notes.md --max-sentence-words 40 --percentile 95 --banned \"$SKILL_EVALS_GRADER_DIR/banned.txt\" --strip-code"
    }
  ]
}
```

The command check scores 1 when the script exits 0. When it exits 1, the check scores 0, and the violations, one on each line, are the `command.stdout` of the check in `results.json`. [Commands after the run](write-a-case.md#commands-after-the-run) says what else a `command` check does.

## What it checks

| Flag                       | What it does                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-sentence-words <n>` | Every sentence has at most `n` words.                                                                                                                                     |
| `--percentile <p>`         | `p` is from 0 to 100. Only the `p`-th percentile of the sentence word counts must be at most the maximum, so a few long sentences may pass. Needs `--max-sentence-words`. |
| `--banned <file>`          | A file with one phrase on each line. A phrase matches without regard to case and on whole words: `delve` does not match `delved`.                                         |
| `--strip-code`             | Removes fenced code blocks and inline code before anything is counted, the banned phrases included.                                                                       |

A flag you leave out is not checked. With no flag, the script prints `ok`.

The percentile is the nearest rank: the word counts of the sentences are sorted, and the count at rank `ceil(p / 100 * n)` is the percentile (the smallest count for 0). With 10 sentences and `--percentile 90`, the 9th shortest sentence must fit, and the longest may be as long as it likes.

## Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Prints `ok`.                                                                        |
| 1    | Prints one violation on each line.                                                  |
| 2    | A usage error, such as a file that does not exist. The reason is on standard error. |

A usage error scores the check 0 like any other failure. Run the script by hand on a sample text before you rely on it.

## How it counts

A sentence ends at a `.`, `!` or `?` that is followed by whitespace or by the end of the text. Nothing else ends one. Abbreviations are not special-cased, so `e.g. this` is two sentences, and `Dr. Who` is two. A line break is whitespace: a bullet list with no full stops is one long sentence. A word is a run of characters that is not whitespace, so a path or a hyphenated word is one word. The count is crude on purpose: you set the limit with it in mind, and it counts the same on every run.
