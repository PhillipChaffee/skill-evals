import type { FieldDef } from "./fields.js";

// The fields of the checks that look at files, in the order the docs list them.
export const FILE_FIELDS: Record<string, FieldDef> = {
  path: {
    type: "path",
    meaning:
      "A path relative to the root, which may not leave it. The root is the workspace or the home, and for `skill_file_read` the skill's own directory. A path with `*`, `?` or `{` is a glob: `*` and `?` stay within a directory, `**` crosses directories, and `{a,b}` matches either. A glob never follows a link, and a path through a link that leaves the root counts as absent.",
  },
  quantifier: {
    type: "enum",
    values: ["any", "all"],
    meaning:
      'For a glob that matches several files: "any" needs one of them to pass, "all" needs every one.',
    default: { value: { file_matches: "any", file_lacks: "all" } },
  },
  root: {
    type: "enum",
    values: ["workspace", "home"],
    meaning:
      'Where the path is looked up: the agent\'s "workspace", or the run\'s throwaway "home", for a skill that writes user-level files.',
    default: { value: { "*": "workspace" } },
  },
  created: {
    type: "bool",
    meaning:
      "True to require that the agent created the file: no file at that path was in the root before the run.",
    default: { value: { "*": false } },
  },
  allow: {
    type: "texts",
    meaning:
      "A non-empty list of globs. Every path the run created, modified or deleted must match one of them.",
  },
  ignore: {
    type: "texts",
    meaning:
      "A list of globs for changed paths to leave out before `allow` is applied, such as a log file the harness writes.",
  },
};
