import fs from "node:fs";
import path from "node:path";
import type { Capability } from "./capabilities.js";
import { CAPABILITIES } from "./capabilities.js";
import type { Harness, Loaded } from "./harnesses/shared.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import type { RunRecord } from "./run.js";

/** What `check --json` says of one harness. */
export interface Probed {
  harness: string;
  /** Whether its executable was found. */
  installed: boolean;
  status: Harness["status"];
  /** A boolean for every capability of the vocabulary: whether this harness declares it. */
  capabilities: Record<Capability, boolean>;
  /** What the probe run's harness said it loaded; every kind null when it did not run or reports none. */
  loaded: Loaded;
  /** Whether the harness reported the subject as loaded; null when it reports nothing, or the probe did not run. */
  pluginLoaded: boolean | null;
  /** How many skills, agents and rules the harness reported, and MCP servers; null where it does not report that kind. */
  skills: number | null;
  agents: number | null;
  rules: number | null;
  /** How many hooks ran in the probe; null for a harness without the `hooks` capability, or when the probe did not run. */
  hooksFired: number | null;
  mcpServers: number | null;
}

/** The titles of the columns that `check` adds to its table, in the order of `extraCells`. */
export const EXTRA_COLUMNS = [
  "Status",
  "Capabilities",
  "Skills reported",
  "Agents reported",
  "Rules reported",
  "Hooks fired",
  "MCP servers reported",
];

/**
 * Says, for every capability of the vocabulary, whether a harness declares it.
 * @param harness - The adapter.
 * @returns One boolean for each key of `CAPABILITIES`.
 */
const capabilitiesOf = (
  harness: Pick<Harness, "capabilities">,
): Record<Capability, boolean> =>
  Object.fromEntries(
    (Object.keys(CAPABILITIES) as Capability[]).map((name) => [
      name,
      harness.capabilities.has(name),
    ]),
  ) as Record<Capability, boolean>;

const countOf = (names: string[] | null): number | null =>
  names === null ? null : names.length;

/**
 * Counts the hooks that ran in the probe, from the run's transcript file.
 * @param record - The probe's record.
 * @param outDir - The output directory that the record's transcript is relative to.
 * @returns The number of hook events; null when the transcript cannot be read.
 */
function hooksIn(record: RunRecord, outDir: string): number | null {
  if (!record.transcriptFile) return null;
  try {
    const events = JSON.parse(
      fs.readFileSync(path.join(outDir, record.transcriptFile), "utf8"),
    ) as { type: string }[];
    return events.filter((event) => event.type === "hook").length;
  } catch {
    return null;
  }
}

/**
 * Sums up what the probe saw of one harness.
 * @param harness - The adapter.
 * @param ran - The probe's record and its output directory; null when the harness is not installed.
 * @returns The entry of `check --json`. The counts come from the probe run and are null where the harness cannot
 *   report them, or did not run.
 */
export function probedOf(
  harness: Harness,
  ran: { record: RunRecord; outDir: string } | null,
): Probed {
  const loaded = ran?.record.loaded ?? NOT_REPORTED;
  return {
    harness: harness.id,
    installed: ran !== null,
    status: harness.status,
    capabilities: capabilitiesOf(harness),
    loaded,
    pluginLoaded: ran?.record.subjectLoaded ?? null,
    skills: countOf(loaded.skills),
    agents: countOf(loaded.agents),
    rules: countOf(loaded.rules),
    hooksFired:
      ran !== null && harness.capabilities.has("hooks")
        ? hooksIn(ran.record, ran.outDir)
        : null,
    mcpServers: countOf(loaded.mcpServers),
  };
}

/**
 * Writes the extra columns of a harness's row in the `check` table.
 * @param probed - What `probedOf` returned.
 * @returns One cell for each of `EXTRA_COLUMNS`; "n/a" for a count that is null.
 */
export function extraCells(probed: Probed): string[] {
  const shown = (count: number | null): string =>
    count === null ? "n/a" : String(count);
  const declared = Object.entries(probed.capabilities)
    .filter(([, has]) => has)
    .map(([name]) => name);
  return [
    probed.status,
    declared.join(", ") || "none",
    shown(probed.skills),
    shown(probed.agents),
    shown(probed.rules),
    shown(probed.hooksFired),
    shown(probed.mcpServers),
  ];
}
