import fs from "node:fs";
import path from "node:path";

/**
 * Warns, once, when a resumed command names a subject with other options than the earlier command did. The runs of that
 * subject are repeated, because the options are part of the run key, and the warning says why.
 * @param outDir - The output directory of the earlier command.
 * @param subjects - The subjects of this command, with their options as text.
 */
export function warnOptionsChanged(
  outDir: string,
  subjects: { label: string; options: string }[],
): void {
  let earlier: { label: string; options?: string }[];
  try {
    const results = JSON.parse(
      fs.readFileSync(path.join(outDir, "results.json"), "utf8"),
    ) as { meta?: { subjects?: typeof earlier } };
    earlier = results.meta?.subjects ?? [];
  } catch {
    // No readable results: nothing to compare with.
    return;
  }
  const changed = subjects.flatMap((now) => {
    const before = earlier.find((one) => one.label === now.label);
    return before !== undefined && (before.options ?? "") !== now.options
      ? [
          `${now.label} (was ${before.options || "no options"}, now ${now.options || "no options"})`,
        ]
      : [];
  });
  if (changed.length > 0) {
    console.error(
      `skill-evals: warning: --resume: the options of ${changed.join(", ")} differ from the earlier command, so the runs of those subjects are repeated`,
    );
  }
}
