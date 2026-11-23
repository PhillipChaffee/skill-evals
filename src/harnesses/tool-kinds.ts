// Every tool kind with what it means. The docs list the kinds from this table.
export const TOOL_KIND_MEANINGS = {
  shell: "Ran a command.",
  read: "Read a file.",
  write: "Created or replaced a file.",
  edit: "Changed part of a file, or deleted one.",
  search: "Searched or listed files.",
  web: "Fetched a page or searched the web.",
  skill:
    "Called the harness's skill tool. Needs no capability: a harness whose adapter maps no skill tool loads skills by reading their files, which `skill_loaded` and `skill_not_loaded` see.",
  subagent:
    "Started another agent. A check or matcher of this kind needs `subagents`, since a harness that cannot show a dispatch would pass every claim that none was made.",
  question:
    "Asked the user a question, as Claude Code's `AskUserQuestion` does. A check or matcher of this kind needs `askUser`.",
  mcp: "Called a tool of an MCP server. The call's name is `<server>.<tool>`. A check or matcher of this kind needs `mcp`.",
  other:
    "Any tool the harness's adapter has no kind for. A check of kind `other` with no `name` also matches `mcp` and `question` calls, as it did before those kinds existed: in 0.0.1 every MCP tool and Claude Code's `AskUserQuestion` had kind `other`.",
} as const;

/** What a tool does, the same word in every harness. */
export type ToolKind = keyof typeof TOOL_KIND_MEANINGS;

// The table's keys are exactly the kinds, so the cast only names them.
export const TOOL_KINDS = Object.keys(TOOL_KIND_MEANINGS) as ToolKind[];
