/** One tool call that a seeded message made. */
export interface HistoryCall {
  /** The tool's name as the harness spells it, such as `Bash`. */
  name: string;
  input: unknown;
  /** What the tool returned; absent when the history leaves it out. */
  output?: string;
}

/** One message of a conversation that already happened. */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** The calls an assistant message made, with their results. */
  toolCalls?: HistoryCall[];
}

/** A conversation that already happened: `history.json` of a case. */
export type History = HistoryMessage[];

/** One earlier session for a harness's prior-session store: an entry of `sessions/sessions.json`. */
export interface PriorSession {
  /** The session's id: letters, digits, `.`, `_` and `-`, because an adapter may use it as a file name. */
  id: string;
  /** When the session began, as a date the JavaScript `Date` reads, such as `2026-01-05T09:00:00Z`. */
  startedAt: string;
  /** The directory the session ran in, relative to the run's workspace, which may not be left; absent: the workspace itself. */
  cwd?: string;
  messages: History;
}

/** How a seeded history reaches the agent. */
export const HISTORY_MODES = ["native", "preamble"] as const;

/**
 * `native`: the adapter writes the history as a session in the harness's own store and resumes it. `preamble`: the
 * history is rendered as a quoted block in front of the first message.
 */
export type HistoryMode = (typeof HISTORY_MODES)[number];

/** The two directories of a run that an adapter plants history in. */
export interface Seeding {
  /** The run's throwaway home. */
  home: string;
  /** The run's workspace. */
  workspace: string;
  /** The start, in milliseconds, of the latest earlier session that was planted; a history is written after it. */
  after?: number;
}

/** The parts of an adapter that seed a conversation or earlier sessions; `Harness` has them. */
export interface HistoryAdapter {
  /**
   * How a case's `history.json` reaches the agent unless `--history-mode` says otherwise. Absent: `preamble`, which every
   * adapter can do, because the runner writes the block itself.
   */
  historyMode?: HistoryMode;
  /**
   * Writes a history into the harness's own session store, where the harness resumes it as its active session. Present
   * exactly for an adapter with the `historyNative` capability. Called after the setup steps and the login files, and
   * before the harness starts.
   * @param history - The messages of `history.json`.
   * @param where - The run's home and workspace.
   * @returns The id of the session that the first turn continues, as `RunInput.session`.
   */
  installHistory?: (history: History, where: Seeding) => { session: string };
  /**
   * Writes earlier sessions into the harness's prior-session store. Present exactly for an adapter with the
   * `sessionStore` capability. Called at the same time as `installHistory`.
   * @param sessions - The sessions of `sessions/sessions.json`.
   * @param where - The run's home and workspace.
   */
  installSessions?: (sessions: PriorSession[], where: Seeding) => void;
}
