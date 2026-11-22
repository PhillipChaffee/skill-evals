import type { FieldDef, Mode } from "./checks/fields.js";
import { readUnblinded } from "./blinding.js";
import { extensionsOf } from "./checks/extensions.js";
import { readField } from "./checks/fields.js";
import { UsageError } from "./scope.js";
import type { Turn } from "./turn-spec.js";
import { readTurns, taskOf } from "./turn-spec.js";

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
  turns: {
    type: "turns",
    meaning:
      "The whole list of turns of the variant, in place of the case's `turns` or `prompt.md`; see the turn keys. Give exactly one of `prompt`, `promptAppend` and `turns`.",
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
  /** The variant's own turns; absent for a variant with a prompt, which is a single prompt. */
  turns?: Turn[];
  heldout: boolean;
  /** The variant's own tags, which the case adds to its own. */
  tags: string[];
  /** The keys that start with `x-`. */
  extensions: Record<string, unknown>;
}

/**
 * Works out the whole prompt of a variant.
 * @param given - The variant's `prompt` and `promptAppend`; `turns` is read apart, and counts only for the rule that
 *   exactly one of the three is set.
 * @param given.prompt - The whole prompt, for a variant that brings its own.
 * @param given.promptAppend - The text to add after the case's prompt.
 * @param base - What the case's `prompt.md` holds; null or empty when it has none.
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
  if (prompt !== undefined) {
    if (prompt.trim() === "") throw new UsageError(`${where}: prompt is empty`);
    return prompt.trim();
  }
  if (!base) {
    throw new UsageError(
      `${where}: "promptAppend" needs a prompt.md with text to append to`,
    );
  }
  if (promptAppend?.trim() === "") {
    throw new UsageError(`${where}: promptAppend is empty`);
  }
  return `${base}\n\n${(promptAppend ?? "").trim()}`;
}

/**
 * Reads what a variant puts to the agent: a whole prompt, or its own turns.
 * @param raw - The variant as the case file holds it.
 * @param read - Reads a key of the variant with its type's parser; undefined for a key that is absent.
 * @param place - The base prompt, the variant's name for messages, and where the case is.
 * @param place.base - What the case's `prompt.md` holds, or null.
 * @param place.where - Names the case file and the variant.
 * @param place.at - The case file, its directory, and how strict loading is.
 * @returns The whole prompt, and the turns when the variant gives them (the prompt then describes them).
 * @throws {UsageError} Unless exactly one of `prompt`, `promptAppend` and `turns` is set, and for a bad one.
 */
function sourceOf(
  raw: Record<string, unknown>,
  read: (key: string) => unknown,
  place: { base: string | null; where: string; at: VariantAt },
): { prompt: string; turns?: Turn[] } {
  const { base, where, at } = place;
  const given = ["prompt", "promptAppend", "turns"].filter(
    (key) => raw[key] !== undefined,
  );
  if (given.length !== 1) {
    throw new UsageError(
      `${where}: a variant needs exactly one of "prompt", "promptAppend" and "turns"`,
    );
  }
  if (at.hasTurns && raw["turns"] === undefined) {
    throw new UsageError(
      `${where}: the case has "turns", so a variant must give "turns" too; "${given[0] ?? ""}" would drop them and every check of a turn`,
    );
  }
  if (raw["turns"] !== undefined) {
    const turns = readTurns(read("turns") as Record<string, unknown>[], {
      file: where,
      dir: at.dir,
      mode: at.mode,
    });
    return { prompt: taskOf(turns), turns };
  }
  return {
    prompt: promptOf(
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
    ),
  };
}

/** Where the variants are: their case file and its directory, and how strict loading is. */
interface VariantAt {
  file: string;
  /** The case's directory, which a turn's prompt file is relative to. */
  dir: string;
  /** Whether the case has its own `turns`, which a variant must then replace with `turns`. */
  hasTurns: boolean;
  mode: Mode;
}

/**
 * Reads the `variants` key of a case file.
 * @param list - The value of the key, already known to be a non-empty list of objects.
 * @param base - What the case's `prompt.md` holds, or null when it has none.
 * @param at - The case file's name, its directory, and how strict loading is.
 * @returns The variants, each with a whole prompt or its own turns, in the order written.
 * @throws {UsageError} For a bad id, a repeated id, an unknown key, a field of the wrong type, or a bad prompt source.
 */
export function readVariants(
  list: Record<string, unknown>[],
  base: string | null,
  at: VariantAt,
): Resolved[] {
  const seen = new Set<string>();
  return list.map((raw, index) => {
    const where = `${at.file} variants[${String(index)}]`;
    const here = { where, owner: "a variant", siblings: raw };
    const extensions = extensionsOf(Object.keys(VARIANT_KEYS), here, at.mode);
    readUnblinded(extensions, where);
    const read = (key: string) =>
      raw[key] === undefined || key === "id"
        ? undefined
        : readField(VARIANT_KEYS, key, here);
    const id = readField(VARIANT_KEYS, "id", here) as string;
    if (seen.has(id)) {
      throw new UsageError(`${where}: duplicate variant id "${id}"`);
    }
    seen.add(id);
    return {
      id,
      ...sourceOf(raw, read, { base, where, at }),
      heldout: (read("heldout") as boolean | undefined) ?? false,
      tags: (read("tags") as string[] | undefined) ?? [],
      extensions,
    };
  });
}
