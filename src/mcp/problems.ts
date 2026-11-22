import type { Harness, Loaded, LoadedSubject } from "../harnesses/shared.js";
import { foreignOf } from "../harnesses/shared.js";

/** What `mcpProblems` reads. */
interface Reading {
  /** The names of the registered mock servers. */
  mocks: string[];
  /** What each harness process reported as loaded. */
  reported: Loaded[];
  /** The state each server reported, for a harness that states one. */
  status: Record<string, string> | null | undefined;
  /** What the run subject is. */
  subject: LoadedSubject | null;
}

/**
 * Finds why a run with mock MCP servers cannot be trusted, besides a mock log that disagrees with the stream.
 * @param harness - The adapter, whose rule says which MCP servers belong to the subject (a plugin's own).
 * @param read - The mock servers and what the harness reported of them.
 * @returns A line for each registered server that the harness did not report or did not report as `connected`, and for
 *   each reported MCP server that is neither a mock server nor one of the subject's own. Empty for a case with no mock
 *   servers, so that no other run changes.
 */
export function mcpProblems(harness: Harness, read: Reading): string[] {
  const { mocks, reported, status, subject } = read;
  if (mocks.length === 0) return [];
  const missing = mocks.filter((name) =>
    reported.some((each) => each.mcpServers && !each.mcpServers.includes(name)),
  );
  const down = mocks.flatMap((name) => {
    const state = status?.[name];
    return state === undefined || state === "connected"
      ? []
      : [`${name} is ${state}`];
  });
  const foreign = reported.flatMap((each) =>
    foreignOf(
      harness,
      {
        paths: null,
        skills: null,
        agents: null,
        rules: null,
        hooks: null,
        plugins: each.plugins ?? null,
        mcpServers:
          each.mcpServers?.filter((name) => !mocks.includes(name)) ?? null,
      },
      subject,
    ),
  );
  return [
    ...missing.map(
      (name) =>
        `the mock server ${name} is missing from what the harness reported`,
    ),
    ...down.map((line) => `the mock server ${line}, not connected`),
    ...foreign.map(
      (line) =>
        `the harness reported ${line}, which is neither a mock server nor the subject's`,
    ),
  ];
}
