// Every tool kind with what it means. The docs list the kinds from this table.
export const TOOL_KIND_MEANINGS = {
  shell: "Ran a command.",
  read: "Read a file.",
  write: "Created or replaced a file.",
  edit: "Changed part of a file, or deleted one.",
  search: "Searched or listed files.",
  web: "Fetched a page or searched the web.",
  skill: "Called the harness's skill tool.",
  subagent: "Started another agent.",
  question:
    "Asked the user a question, as Claude Code's `AskUserQuestion` does.",
  mcp: "Called a tool of an MCP server. The call's name is `<server>.<tool>`.",
  other:
    "Any tool the harness's adapter has no kind for. A check of kind `other` with no `name` also matches `mcp` calls, as it did before the kind existed. It matches `mcp` because in 0.0.1 every MCP tool had kind `other`; it does not match `question`, which was already a kind of its own, so no `other` check ever counted it.",
} as const;

/** What a tool does, the same word in every harness. */
export type ToolKind = keyof typeof TOOL_KIND_MEANINGS;

// The table's keys are exactly the kinds, so the cast only names them.
export const TOOL_KINDS = Object.keys(TOOL_KIND_MEANINGS) as ToolKind[];
