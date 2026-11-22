import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  PROTOCOL_VERSIONS,
  main,
  readServer,
  respond,
  serve,
} from "./mcp/mock-server.js";
import { sandbox } from "./testing/sandbox.js";

const SETTLE_MS = 20;
const GET_ISSUE = "get_issue";
const ID_SHOP_7 = "SHOP-7";
const TOOLS_CALL = "tools/call";
const JSONRPC = "2.0";
const INITIALIZE = "initialize";
const CART = "SHOP-7: Cart empties on login.";

/**
 * Starts a server on two pipes, as a harness would, to talk to it.
 * @param dir - The directory of the server's tool files.
 * @param log - The log file the server appends to; absent: none.
 * @returns A `send` that writes messages, ends the input and returns every reply once the server has answered.
 */
function piped(dir: string, log?: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      replies.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const done = serve(readServer("tracker", dir), { input, output }, log);
  return {
    /**
     * Sends messages, then ends the input.
     * @param messages - Objects, written as JSON, or strings, written as they are.
     * @returns Every reply the server wrote.
     */
    async send(...messages: unknown[]) {
      for (const message of messages) {
        const line =
          typeof message === "string" ? message : JSON.stringify(message);
        input.write(`${line}\n`);
      }
      input.end();
      await done;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return replies;
    },
  };
}

/**
 * Writes a server with a templated tool, an error variant for one id, and a response that needs a second argument.
 * @param box - The sandbox.
 * @returns The server's directory.
 */
function plantServer(box: ReturnType<typeof sandbox>): string {
  box.write("mock/tracker/fallback.json", {
    description: "Always answers.",
    inputSchema: {},
    responses: [{ text: "always" }],
  });
  box.write(`mock/tracker/${GET_ISSUE}.json`, {
    description: "Read one issue.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    responses: [
      { when: { id: "^SHOP-7$" }, text: "{{id}}: Cart empties on login." },
      {
        when: { id: "^SHOP-9999$" },
        text: "no such issue: {{id}}",
        isError: true,
      },
      { when: { id: "^SHOP-" }, text: "{{id}} then {{who}}" },
    ],
  });
  return path.join(box.root, "mock/tracker");
}

/**
 * Makes a request.
 * @param id - The request's id, which the reply repeats.
 * @param method - The JSON-RPC method, such as `ping`.
 * @param params - The params; absent: none.
 * @returns The JSON-RPC request.
 */
const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: JSONRPC,
  id,
  method,
  ...(params !== undefined && { params }),
});

test("the server answers tools/list and a templated tools/call over a pipe", async () => {
  const box = sandbox();
  const dir = plantServer(box);
  const log = path.join(box.root, "mock.log");
  const replies = await piped(dir, log).send(
    request(1, INITIALIZE, { protocolVersion: "2025-03-26" }),
    { jsonrpc: JSONRPC, method: "notifications/initialized" },
    request(2, "tools/list"),
    request(3, TOOLS_CALL, { name: GET_ISSUE, arguments: { id: ID_SHOP_7 } }),
    request(4, "ping"),
  );
  // The notification gets no reply.
  expect(replies.map((reply) => reply["id"])).toEqual([1, 2, 3, 4]);
  expect(replies[0]?.["result"]).toMatchObject({
    protocolVersion: "2025-03-26",
    capabilities: { tools: {} },
  });
  expect(replies[1]?.["result"]).toEqual({
    tools: [
      { name: "fallback", description: "Always answers.", inputSchema: {} },
      {
        name: GET_ISSUE,
        description: "Read one issue.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
  });
  expect(replies[2]?.["result"]).toEqual({
    content: [{ type: "text", text: CART }],
  });
  expect(replies[3]?.["result"]).toEqual({});
  const logged = fs.readFileSync(log, "utf8").trim().split("\n");
  expect(logged).toHaveLength(1);
  expect(JSON.parse(logged[0] ?? "")).toMatchObject({
    server: "tracker",
    tool: GET_ISSUE,
    input: { id: ID_SHOP_7 },
    response: { text: CART, isError: false },
  });
});

test("initialize answers the version the client asked for when it is known, else the latest", async () => {
  const dir = plantServer(sandbox());
  const answerTo = async (params?: unknown) =>
    (await piped(dir).send(request(1, INITIALIZE, params)))[0]?.["result"];
  expect(await answerTo({ protocolVersion: "2024-11-05" })).toMatchObject({
    protocolVersion: "2024-11-05",
  });
  const latest = { protocolVersion: PROTOCOL_VERSIONS[0] };
  expect(await answerTo({ protocolVersion: "2031-01-01" })).toMatchObject(
    latest,
  );
  expect(await answerTo()).toMatchObject(latest);
});

test("an unknown JSON-RPC method is error -32601, and a bad message is an error that names why", async () => {
  const dir = plantServer(sandbox());
  const replies = await piped(dir).send(
    request(1, "resources/list"),
    // An unknown notification gets no reply.
    { jsonrpc: JSONRPC, method: "notifications/whatever" },
    "not json",
    "[1]",
    { jsonrpc: JSONRPC, id: 2, method: 7 },
    { jsonrpc: JSONRPC, method: 7 },
    // A request that is a notification, with no id, gets no reply, whatever its method.
    { jsonrpc: JSONRPC, method: "ping" },
    request(6, TOOLS_CALL, { name: "fallback" }),
    { jsonrpc: JSONRPC, id: 3, result: {} },
    "",
    request(4, TOOLS_CALL, { name: "no_such_tool", arguments: {} }),
    request(5, TOOLS_CALL, { name: GET_ISSUE, arguments: [] }),
  );
  const codes = replies.map(
    (reply) => (reply["error"] as { code: number } | undefined)?.code,
  );
  expect(codes).toEqual([
    ...[-32601, -32700, -32600, -32600, -32600, undefined],
    ...[-32602, undefined],
  ]);
  expect(replies[0]?.["error"]).toMatchObject({
    message: "Method not found: resources/list",
  });
  expect(replies[6]?.["error"]).toMatchObject({ message: "unknown tool" });
  expect(replies[7]?.["result"]).toMatchObject({ isError: true });
  // A call with no arguments is answered, and a response with no `when` fits it.
  expect(replies[5]?.["result"]).toEqual({
    content: [{ type: "text", text: "always" }],
  });
});

test("a missing placeholder argument is an error result that names it, and no match is an error result", () => {
  const tool = readServer("tracker", plantServer(sandbox())).tools[GET_ISSUE];
  if (!tool) throw new Error("no tool");
  expect(respond(tool, { id: "SHOP-1" })).toEqual({
    text: 'missing argument "who"',
    isError: true,
  });
  const two = { ...tool, responses: [{ text: "{{a}} {{b}} {{a}}" }] };
  expect(respond(two, { b: 1 }).text).toBe('missing argument "a", "a"');
  expect(respond(tool, { id: "SHOP-1", who: "me" })).toEqual({
    text: "SHOP-1 then me",
    isError: false,
  });
  // No `when` fits: the argument is absent, or its value does not match.
  const none = { text: "no response matches", isError: true };
  expect(respond(tool, {})).toEqual(none);
  expect(respond(tool, { id: "OTHER-1" })).toEqual(none);
  // Numbers, booleans and objects are written as text for a pattern and a placeholder.
  const typed = {
    ...tool,
    responses: [{ when: { n: "^5$" }, text: "{{n}} {{o}} {{b}}" }],
  };
  expect(respond(typed, { n: 5, o: { a: 1 }, b: true }).text).toBe(
    '5 {"a":1} true',
  );
});

test("an error variant is returned for a planted id", async () => {
  const dir = plantServer(sandbox());
  const replies = await piped(dir).send(
    request(1, TOOLS_CALL, {
      name: GET_ISSUE,
      arguments: { id: "SHOP-9999" },
    }),
  );
  expect(replies[0]?.["result"]).toEqual({
    content: [{ type: "text", text: "no such issue: SHOP-9999" }],
    isError: true,
  });
  // The first matching response wins: an id that two `when`s fit gets the earlier.
  const tool = readServer("tracker", dir).tools[GET_ISSUE];
  if (!tool) throw new Error("no tool");
  expect(respond(tool, { id: "SHOP-9999", who: "x" }).isError).toBe(true);
});

test("main needs a server name and a directory, and serves what it is given", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const dir = plantServer(sandbox());
  const usage = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await main([], {})).toBe(2);
  expect(usage).toHaveBeenCalledWith(
    "usage: skill-evals-mcp-mock <server> <directory>\n",
  );
  usage.mockRestore();
  const served = main(["tracker", dir], {}, { input, output });
  input.end(`${JSON.stringify(request(1, "ping"))}\n`);
  expect(await served).toBe(0);
  expect(String(output.read())).toContain('"result":{}');
});

test("a notification is never run, a null id is invalid, and only a call's own arguments fill a placeholder", async () => {
  const box = sandbox();
  const dir = plantServer(box);
  const log = path.join(box.root, "n.log");
  const replies = await piped(dir, log).send(
    // A tools/call with no id is a notification: it gets no reply and is not run, so the log has no line for it.
    {
      jsonrpc: JSONRPC,
      method: TOOLS_CALL,
      params: { name: GET_ISSUE, arguments: { id: ID_SHOP_7 } },
    },
    { jsonrpc: JSONRPC, id: null, method: "ping" },
    request(1, INITIALIZE, { protocolVersion: "2025-11-25" }),
  );
  expect(fs.existsSync(log)).toBe(false);
  expect(replies[0]?.["error"]).toMatchObject({ code: -32600 });
  // The server names itself by its bare name.
  expect(replies[1]?.["result"]).toMatchObject({
    serverInfo: { name: "tracker" },
  });
  const tool = readServer("tracker", dir).tools[GET_ISSUE];
  if (!tool) throw new Error("no tool");
  const inherited = { ...tool, responses: [{ text: "{{toString}}" }] };
  expect(respond(inherited, {}).text).toBe('missing argument "toString"');
  const byName = {
    ...tool,
    responses: [{ when: { constructor: "." }, text: "t" }],
  };
  expect(respond(byName, {}).text).toBe("no response matches");
});
