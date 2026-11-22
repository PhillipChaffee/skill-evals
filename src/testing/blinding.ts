import { skillsFolder } from "./plant.js";
import type { Sandbox } from "./sandbox.js";

/** The check that every planted case has. */
const FINE = { type: "file_exists", path: "notes.txt" };

/** What a planted case holds. */
interface Parts {
  /** What `prompt.md` holds. Default: a neutral sentence. */
  prompt?: string;
  /** Keys of the case file besides `checks`. */
  file?: Record<string, unknown>;
  /** More files, by their path below the case's directory. */
  files?: Record<string, unknown>;
}

/**
 * Writes a case.
 * @param box - The sandbox.
 * @param id - The case's directory below `cases`.
 * @param parts - The prompt, the keys of the case file, and the other files.
 */
export function plantBlind(box: Sandbox, id: string, parts: Parts = {}): void {
  box.write(`cases/${id}/prompt.md`, parts.prompt ?? "say it\n");
  box.write(`cases/${id}/case.json`, { checks: [FINE], ...parts.file });
  for (const [file, content] of Object.entries(parts.files ?? {})) {
    box.write(`cases/${id}/${file}`, content);
  }
}

/**
 * Runs `validate` on the planted cases, with a subject that has skills.
 * @param box - The sandbox.
 * @param more - More flags.
 * @param skills - The skills of the subject, by name. Default: one called `alpha`.
 * @returns The exit status, and the lines it printed.
 */
export async function validated(
  box: Sandbox,
  more: string[] = [],
  skills: Record<string, string> = { alpha: "# alpha\n" },
): Promise<{ status: number; lines: string[] }> {
  const subject = skillsFolder(box, "skills", skills);
  const ran = await box.cli([
    "validate",
    ...["--subject", subject, "--cases", `${box.root}/cases`],
    ...more,
  ]);
  return { status: ran.status, lines: ran.stdout.trim().split("\n") };
}
