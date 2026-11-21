import type { FieldDef, Mode } from "./checks/fields.js";
import { extensionsOf } from "./checks/extensions.js";
import { readField } from "./checks/fields.js";
import { UsageError } from "./scope.js";

/** One way to put a case to the agent: a paraphrase, a pressure, a held-out check. It shares everything else with its case. */
export interface Variant {
  /** Lowercase letters, digits and hyphens; unique within the case. The case runs as `<case id>@<id>`. */
  id: string;
  /** Text appended to the case's `prompt.md`, after a blank line. */
  promptAppend?: string;
  /** The whole prompt, in place of `prompt.md`. */
  prompt?: string;
  /** True for a variant that runs only with `--heldout`. */
  heldout?: boolean;
  /** Tags added to the case's tags for this variant. */
  tags?: string[];
}

// The keys of a variant. Any other key is a load error, unless it starts with `x-`.
export const VARIANT_KEYS: Record<string, FieldDef> = {
  id: {
    type: "slug",
    meaning:
      "The variant's name: lowercase letters, digits and hyphens, unique within the case. The case runs as `<case id>@<id>`.",
  },
  prompt: {
    type: "text",
    meaning:
      "The whole prompt of the variant, in place of `prompt.md`. Give this or `promptAppend`, not both.",
  },
  promptAppend: {
    type: "text",
    meaning:
      "Text added to the case's `prompt.md` after a blank line. Needs a `prompt.md`. Give this or `prompt`, not both.",
  },
  heldout: {
    type: "bool",
    meaning:
      "True for a variant that runs only with `--heldout`, so that tuning a skill does not see it. Default: false.",
  },
  tags: {
    type: "tags",
    meaning: "Tags added to the case's tags for this variant.",
  },
};

/** A variant as the case loader needs it: its prompt is whole. */
export interface Resolved {
  id: string;
  prompt: string;
  heldout: boolean;
  /** The variant's own tags, which the case adds to its own. */
  tags: string[];
  /** The keys that start with `x-`. */
  extensions: Record<string, unknown>;
}

/**
 * Works out the whole prompt of a variant.
 * @param given - The variant's `prompt` and `promptAppend`.
 * @param given.prompt - The whole prompt, for a variant that brings its own.
 * @param given.promptAppend - The text to add after the case's prompt.
 * @param base - What the case's `prompt.md` holds, or null when it has none.
 * @param where - Names the file and the variant in an error message.
 * @returns The whole prompt, trimmed.
 * @throws {UsageError} Unless exactly one of the two is set; for an append with no `prompt.md`; for a blank prompt.
 */
function promptOf(
  given: { prompt?: string; promptAppend?: string },
  base: string | null,
  where: string,
): string {
  const { prompt, promptAppend } = given;
  if ((prompt === undefined) === (promptAppend === undefined)) {
    throw new UsageError(
      `${where}: a variant needs exactly one of "prompt" and "promptAppend"`,
    );
  }
  if (prompt !== undefined) {
    if (prompt.trim() === "") throw new UsageError(`${where}: prompt is empty`);
    return prompt.trim();
  }
  if (base === null) {
    throw new UsageError(
      `${where}: "promptAppend" needs a prompt.md to append to`,
    );
  }
  return `${base}\n\n${(promptAppend ?? "").trim()}`;
}

/**
 * Reads the `variants` key of a case file.
 * @param list - The value of the key, already known to be a non-empty list of objects.
 * @param base - What the case's `prompt.md` holds, or null when it has none.
 * @param at - The case file's name, and how strict loading is.
 * @param at.file - The case file.
 * @param at.mode - Whether a key a variant does not take is an error or is dropped with a warning.
 * @returns The variants, each with a whole prompt, in the order written.
 * @throws {UsageError} For a bad id, a repeated id, an unknown key, a field of the wrong type, or a bad prompt source.
 */
export function readVariants(
  list: Record<string, unknown>[],
  base: string | null,
  at: { file: string; mode: Mode },
): Resolved[] {
  const seen = new Set<string>();
  return list.map((raw, index) => {
    const where = `${at.file} variants[${String(index)}]`;
    const here = { where, owner: "a variant", siblings: raw };
    const extensions = extensionsOf(Object.keys(VARIANT_KEYS), here, at.mode);
    const read = (key: string) =>
      raw[key] === undefined || key === "id"
        ? undefined
        : readField(VARIANT_KEYS, key, here);
    const id = readField(VARIANT_KEYS, "id", here) as string;
    if (seen.has(id)) {
      throw new UsageError(`${where}: duplicate variant id "${id}"`);
    }
    seen.add(id);
    const prompt = promptOf(
      {
        ...(raw["prompt"] !== undefined && {
          prompt: read("prompt") as string,
        }),
        ...(raw["promptAppend"] !== undefined && {
          promptAppend: read("promptAppend") as string,
        }),
      },
      base,
      where,
    );
    return {
      id,
      prompt,
      heldout: (read("heldout") as boolean | undefined) ?? false,
      tags: (read("tags") as string[] | undefined) ?? [],
      extensions,
    };
  });
}
