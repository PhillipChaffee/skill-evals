import type { Lint } from "./commands/validate.js";
import { textHits } from "./blinding.js";
import { rulesFilesOf } from "./subject-rules.js";
import type { Subject } from "./subject.js";

/**
 * Says what `validate` did not check, or checked and leaves alone, about blinding words.
 * @param context - Where the suite is, the subject, and the words.
 * @param context.casesDir - The cases directory, which names a note about the suite as a whole.
 * @param context.subject - The resolved subject, or null.
 * @param context.words - The blinding words in force.
 * @returns A note when the list is empty, so that nothing was checked; and a note listing the paths of the subject's rule
 *   files that hold a word. Those belong to the subject and stay exempt: the note only tells you what the agent sees.
 */
export function blindingNotes(context: {
  casesDir: string;
  subject: Subject | null;
  words: readonly string[];
}): Lint[] {
  const { casesDir, subject, words } = context;
  if (words.length === 0) {
    return [
      {
        level: "warning",
        caseId: casesDir,
        text: "note: blindingWords is empty, so no blinding word was checked",
      },
    ];
  }
  if (subject?.rules == null || subject.exported === null) return [];
  const held = rulesFilesOf(subject.rules, subject.exported)
    .map(({ relative }) => relative)
    .filter((relative) => textHits(relative, words).length > 0);
  return held.length === 0
    ? []
    : [
        {
          level: "warning",
          caseId: casesDir,
          text: `note: the subject's rule file paths hold a blinding word, which the agent can see; they belong to the subject and are not counted: ${held.join(", ")}`,
        },
      ];
}
