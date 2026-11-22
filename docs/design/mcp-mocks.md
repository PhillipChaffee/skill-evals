# Mock MCP servers

## Decision

- **Layout.** A case may have `mcp/<server>/<tool>.json`. Each file is `{ description, inputSchema, responses: [{ when?, text, isError? }] }`. The loader is strict: an unknown key, a file that is not a regular `<tool>.json`, a link, an empty server or an empty `mcp/` is a load error. A server name and a tool name match `^[a-z][a-z0-9_-]*$`, and a server name may not hold `__` (Claude Code splits `mcp__<server>__<tool>` at the first `__` after the server). Every `when` pattern is compiled at load time. The patterns have no flags: use a character class such as `[Cc]heckout` for a case-blind match.
- **Responses.** The first response whose `when` fits wins. A `when` maps an argument name to a regular expression that the argument's text must match; an absent argument never matches. If none fits, the result is an error with the text `no response matches`. `{{argument}}` in `text` is filled from the call's arguments (numbers and booleans as `String` writes them, objects as JSON). A placeholder whose argument the call did not give makes the result an error that names it: `missing argument "who"`.
- **The server.** `skill-evals-mcp-mock <server> <directory>` (the `bin` entry `dist/mcp/mock-server.js`) is one zero-dependency file. It speaks JSON-RPC 2.0, one message per line on standard input and output, and handles `initialize`, `notifications/initialized`, `tools/list`, `tools/call` and `ping`. A request for any other method gets error -32601, an unknown tool -32602, a line that is not JSON -32700 and a message that is not a request -32600. A notification gets no reply. `initialize` answers the protocol version the client asked for when the mock knows it, else the mock's latest, `2025-11-25`. Each answered call is appended to `$MOCK_LOG` as `{ server, tool, input, response: { text, isError }, at }`.
- **Isolation.** For each run the specs are copied into a temporary directory that is neither inside the workspace nor inside the home, and the servers start from there, so no path the agent can see names the cases directory. `MOCK_LOG` lives in that directory and is set in the server's own environment, in the harness's MCP config, and never in the agent's. After the run the log is read, and a copy is kept as `<label><rep>.mock-log.jsonl` beside the transcript.
- **Registration.** `Harness.registerMcp(servers, input)` writes what the harness reads into the run's mock directory, and `invocation` then names it. Claude Code gets `--mcp-config <dir>/mcp-config.json`. The capability `mcp` is declared only for an adapter that has `registerMcp`. A case with an `mcp/` directory needs `mcp`, so on any other harness it is not applicable.
- **`--isolated`.** The registered mock servers are part of the subject and never count as unexpected. Any other MCP server that the harness reports is still foreign, so the run is invalid. The run record's `loaded.mcpServers` still lists the mock servers as the harness reported them.
- **The kind.** Tool kind `mcp`. Claude Code maps `mcp__<server>__<tool>` to kind `mcp` and the name `<server>.<tool>`. For 0.0.1 compatibility a check with `kind: "other"` and no `name` also matches an `mcp` call, as it matched an MCP tool before the kind existed; with a `name` it does not, because the name changed shape.
- **No MCP calls in the stream.** An adapter with `mcp` whose stream shows none of the calls gets them from the mock log: the runner adds a `tool_call` and a `tool_result` for each logged call, marked `source: "mock-log"`. Events that state a time (`at`) take their place by time; when none does, the calls go last. The agent of those calls has the type `unknown` (depth 1, as an orphan child event does), so a `by` that names a real agent, or `main`, does not count them. A `by` check still needs `childCalls`, so on a harness without it the case is not applicable. No shipped adapter reads times from its stream today.
- **Hashes.** The `mcp/` directory is hashed by content in `caseHash` and in `inputHash`, only for a case that has one, so the hashes of every other case are what they were. The run key does not change: the command line gains a flag only for a case that has `mcp/`.
- **Scope.** A case has its own `mcp/` directory. A suite-wide `mcp/` shared by every case was not built: it would make every case need `mcp` and change every hash.

## Evidence

Read from the installed binary, `claude` 2.1.330 (`/opt/claude-code/bin/claude`), with `--help` and `grep -a`. There is no network here, so the MCP specification was not read: the protocol was taken from the client code inside the binary. No model was run.

### Claude Code: confirmed from the binary

- `claude --help`: `--mcp-config <configs...>` "Load MCP servers from JSON files or strings (space-separated)"; `--strict-mcp-config` "Only use MCP servers from --mcp-config, ignoring all other MCP configurations". The flag takes a list, so the adapter puts it before another flag and never last before `--`. `--isolated` already passes `--strict-mcp-config`; a run without it also loads the user's other servers, and the mock servers are not strict by themselves, because whether the flag drops a subject plugin's own servers was never confirmed.
- The client's protocol versions: `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`, latest first, in two places (`wZn` and `FXt`, with `Jt = "2025-11-25"` the latest). The mock lists the same five and answers the requested one when it is among them.
- The message shapes, from the zod definitions: an `initialize` request has `params: { protocolVersion, capabilities, clientInfo }`; its result has `{ protocolVersion, capabilities, serverInfo, instructions? }`; `notifications/initialized` and `ping` exist; a tool is `{ name, description, inputSchema: { type: "object", ... } }`; a call result is `{ content: [...], structuredContent?, isError? }`.
- The method list that the client's own bridge treats as the server methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- The unknown-method error: `-32601: '<method>' wasn't found` in the binary's own JSON-RPC code.
- Tool naming: the binary has `p = "mcp__"` and splits a name with `e.split("__")`, taking the server as part 1 and the tool as the rest joined with `__`; a name with fewer than three parts is not an MCP name. Server names are normalised with `replace(/[^a-zA-Z0-9_-]/g, "_")`, which a name matching `^[a-z][a-z0-9_-]*$` passes through unchanged.
- The config file: the binary's schema for it is `{ mcpServers: { <name>: <server> } }`, and a stdio server is `{ type: "stdio", command, args, env }`.
- The init event lists `mcp_servers` (the adapter already read `{ name }` from it).

### Claude Code: not confirmed

- That a real model run starts the mock servers from `--mcp-config`, sees `mcp__<server>__<tool>` in its stream, and passes a tool's arguments as `input`. Task 29 confirms it. The fake harness plays the same flow: it reads the config file, starts each server from the command in it, speaks the handshake and the call, and states the call as `mcp__<server>__<tool>`.
- That the status in the init event's `mcp_servers` is `connected` for a stdio server that answers `initialize`.
- Whether `--strict-mcp-config` drops a subject plugin's own MCP servers.
- The MCP specification text. Nothing here was checked against it, only against what the client in the binary sends and accepts.

### Other harnesses

None declares `mcp`. Codex, Cursor, OpenCode and Pi were not looked at for a registration mechanism in this task; a case with an `mcp/` directory is not applicable to them.
