import { formatScore } from "../score.js";
import type { DiscriminationRow } from "./delta.js";
import { discriminationRule } from "./delta.js";

const escape = (text: string): string => text.replaceAll("|", "\\|");

/**
 * Words the discrimination of the cases of one harness.
 * @param discrimination - Its rows.
 * @param many - True for a comparison of more than two subjects, whose rows name the subject they are for.
 * @returns The table; none without a row.
 */
export function discriminationLines(
  discrimination: DiscriminationRow[],
  many: boolean,
): string[] {
  if (discrimination.length === 0) return [];
  return [
    "",
    "### Discrimination",
    "",
    discriminationRule(),
    "",
    many
      ? "| Case | Subject arm | None | Subject | Discrimination |"
      : "| Case | None | Subject | Discrimination |",
    many ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |",
    ...discrimination.map(
      (row) =>
        `| ${escape(row.caseId)} | ${many ? `${escape(row.arm)} | ` : ""}${formatScore(row.none)} | ${formatScore(row.subject)} | ${row.label} |`,
    ),
  ];
}
