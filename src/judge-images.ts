import crypto from "node:crypto";
import fs from "node:fs";
import { find } from "./checks/tree.js";
import type { Attachment } from "./judge-api.js";

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const BYTES_PER_MIB = 1_048_576;
const MAX_IMAGE_MIB = 5;
const MAX_IMAGE_BYTES = MAX_IMAGE_MIB * BYTES_PER_MIB;

/**
 * Reads the images that a judge check names, to send them with the prompt.
 * @param globs - Paths or globs of the workspace, as for `files`.
 * @param workspace - The workspace as the run left it.
 * @returns Each png, jpeg, gif or webp file of at most 5 MB, once, in path order. Any other file is left to the text.
 */
export function imagesOf(globs: string[], workspace: string): Attachment[] {
  const tree = {
    dir: workspace,
    seed: new Map<string, string>(),
    changed: { created: [], modified: [], deleted: [] },
    name: "workspace" as const,
    unlisted: [],
  };
  const files = new Map<string, string>();
  for (const glob of globs) {
    for (const entry of find(tree, glob, true).entries) {
      if (entry.kind === "file") files.set(entry.path, entry.real);
    }
  }
  return [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, real]) => {
      const mediaType =
        MEDIA_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
      if (mediaType === undefined || fs.statSync(real).size > MAX_IMAGE_BYTES) {
        return [];
      }
      const bytes = fs.readFileSync(real);
      return [
        {
          name,
          mediaType,
          data: bytes.toString("base64"),
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        },
      ];
    });
}
