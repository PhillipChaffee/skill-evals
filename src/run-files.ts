import type { Outcome } from "./checks/index.js";
import type { SessionResult } from "./session.js";
import { diffSnapshots, snapshot } from "./snapshot.js";

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
  "workspace" | "seed" | "changed" | "home" | "homeSeed" | "homeChanged"
> {
  const { workspace, seed, home, homeSeed } = ran;
  return {
    workspace,
    seed,
    changed: diffSnapshots(seed, snapshot(workspace)),
    home,
    homeSeed,
    homeChanged: diffSnapshots(homeSeed, snapshot(home)),
  };
}
