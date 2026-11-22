/** What a server's or a tool's name looks like. A server's name may not hold `__`, which Claude Code splits tool names at. */
export const MCP_NAME = /^[a-z][a-z0-9_-]*$/;

/** One response a mock tool can give; the first whose `when` fits the call's arguments wins. */
export interface McpResponse {
  /** Argument name to a regular expression its value must match. Absent: the response fits every call. */
  when?: Record<string, string>;
  /** The text returned; `{{argument}}` is filled from the call's arguments. */
  text: string;
  /** True for a result that the tool marks as failed. */
  isError?: boolean;
}

/** The content of one `<server>/<tool>.json` file. */
export interface McpTool {
  description: string;
  /** The JSON Schema of the tool's arguments, as `tools/list` states it. */
  inputSchema: Record<string, unknown>;
  responses: McpResponse[];
}

/** What a mock server answered to one call. */
export interface McpAnswer {
  text: string;
  isError: boolean;
}

/** One line of the mock log: a call a mock server answered. */
export interface McpCall {
  server: string;
  tool: string;
  input: unknown;
  response: McpAnswer;
  /** When the server answered, as an ISO 8601 time. */
  at: string;
}

/** The mock servers of a case: the case's `mcp/` directory, and the names of the servers in it. */
export interface McpSource {
  /** The absolute path of the case's `mcp/` directory. */
  dir: string;
  /** The server names, sorted. */
  servers: string[];
}

/** One server as a harness is told to start it. */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What an adapter gets to register a run's mock servers. */
export interface McpRegistration {
  /** The run's own mock directory, outside the workspace and the home, where the adapter writes its config. */
  dir: string;
  home: string;
  workspace: string;
}
