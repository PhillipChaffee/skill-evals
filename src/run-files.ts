import type { Outcome } from "./checks/index.js";
import type { Snapshot } from "./snapshot.js";
import type { SessionResult } from "./session.js";
import { diffSnapshots, snapshot, unlistedIn } from "./snapshot.js";

/**
 * Hashes the workspace and the home as the run left them, and compares them with the seeds.
 * A directory that the agent deleted is an empty snapshot, so every seeded file in it reads as deleted.
 * @param ran - What the session produced, while its directories still exist.
 * @returns The file fields of an outcome: both directories, both seeds, and what changed in each.
 */
export function fileState(
  ran: Pick<SessionResult, "workspace" | "seed" | "home" | "homeSeed">,
): Pick<
  Outcome,
  | "workspace"
  | "seed"
  | "changed"
  | "unlisted"
  | "home"
  | "homeSeed"
  | "homeChanged"
  | "homeUnlisted"
> {
  const { workspace, seed, home, homeSeed } = ran;
  const after = snapshot(workspace);
  const homeAfter = snapshot(home);
  const both = (before: Snapshot, later: Snapshot): string[] => [
    ...new Set([...unlistedIn(before), ...unlistedIn(later)]),
  ];
  return {
    workspace,
    seed,
    changed: diffSnapshots(seed, after),
    unlisted: both(seed, after),
    home,
    homeSeed,
    homeChanged: diffSnapshots(homeSeed, homeAfter),
    homeUnlisted: both(homeSeed, homeAfter),
  };
}
