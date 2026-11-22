import { execFileSync } from "node:child_process";
import { findOnPath } from "./capabilities.js";
import { UsageError } from "./scope.js";

/** The tools that confine a process, by the operating system they belong to. */
export type Backend = "bwrap" | "sandbox-exec";

/** What a case may ask of the network. */
export const NETWORKS = ["off", "provider-only", "open"] as const;
export type Network = (typeof NETWORKS)[number];

/** What a sandbox lets a process do. */
export interface Policy {
  /** The directories the process may write to. Everything else is read-only. */
  writable: string[];
  /** The directories that stay read-only even when they are inside a writable one. Bound after the writable ones. */
  readable: string[];
  network: Network;
  /** Only for `bwrap`: directories hidden behind an empty tmpfs, after `/` is bound read-only. */
  masked?: string[] | undefined;
  /** Only for `bwrap`: paths bound back read-only into a masked directory, for what the harness needs to start. */
  exposed?: string[] | undefined;
  /** Files that are writable although the directory around them is read-only: bound after `readable`. */
  appendable?: string[] | undefined;
}

/** What this machine can enforce, worked out once when a command starts. */
export interface SandboxCapability {
  backend: Backend;
  /** The network modes the backend can enforce. `provider-only` needs a host allowlist that neither backend has. */
  network: Network[];
}

/** What a run asks of the sandbox, and the temp directory that session fills in. */
export interface Confinement {
  backend: Backend;
  network: Network;
  /** The run's own temp directory, which the process gets as `TMPDIR`; set by the session. */
  tmp?: string | undefined;
  /** Directories to hide; see `Policy.masked`. */
  masked?: string[] | undefined;
  /** Paths to bind back read-only; see `Policy.exposed`. */
  exposed?: string[] | undefined;
  /** Writable directories besides the workspace, the home and `tmp`, such as the run's fixture remotes; the session adds them. */
  writable?: string[] | undefined;
  /** Writable files inside a read-only directory, such as the mock log; the session adds them. */
  appendable?: string[] | undefined;
}

const BWRAP: Backend = "bwrap";
const SANDBOX_EXEC: Backend = "sandbox-exec";
const BACKENDS: { platform: NodeJS.Platform; backend: Backend }[] = [
  { platform: "linux", backend: BWRAP },
  { platform: "darwin", backend: SANDBOX_EXEC },
];

/**
 * Finds the sandbox tool of this machine.
 * @param env - Where `PATH` is read from. Default: the process's.
 * @param platform - The operating system. Default: this one.
 * @returns `bwrap` on Linux or `sandbox-exec` on macOS when it is an executable on `PATH`; null otherwise.
 */
export function sandboxBackend(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Backend | null {
  const known = BACKENDS.find((entry) => entry.platform === platform);
  return known && findOnPath(known.backend, env) !== null
    ? known.backend
    : null;
}

/**
 * Works out what this machine's sandbox can enforce.
 * @param env - Where `PATH` is read from.
 * @param platform - The operating system. Default: this one.
 * @returns The backend and the network modes it enforces, or null without a backend.
 */
export function sandboxCapability(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): SandboxCapability | null {
  const backend = sandboxBackend(env, platform);
  return backend === null ? null : { backend, network: ["off", "open"] };
}

const PROBES: Record<Backend, string[]> = {
  bwrap: ["--ro-bind", "/", "/", "--unshare-all", "true"],
  "sandbox-exec": ["-p", "(version 1)(allow default)", "true"],
};
const PROBE_MS = 10_000;

/**
 * Computes the sandbox capability for `--sandbox`, and starts the backend once to see that it works.
 * @param env - Where `PATH` is read from.
 * @param platform - The operating system. Default: this one.
 * @returns The capability.
 * @throws {UsageError} When no backend is installed, or the backend cannot start a process here (bwrap needs user
 *   namespaces), so that a run is never made without the sandbox it asked for.
 */
export function requireSandbox(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): SandboxCapability {
  const found = sandboxCapability(env, platform);
  if (found === null) {
    throw new UsageError(
      "no sandbox backend found (looked for bwrap, sandbox-exec)",
    );
  }
  try {
    execFileSync(
      findOnPath(found.backend, env) ?? found.backend,
      PROBES[found.backend],
      { stdio: "ignore", timeout: PROBE_MS, env },
    );
  } catch (error) {
    throw new UsageError(
      `the sandbox backend ${found.backend} is installed but cannot start a process here: ${(error as Error).message}`,
    );
  }
  return found;
}

/**
 * Quotes a path for a sandbox profile.
 * @param file - A path.
 * @returns The path as an SBPL string.
 */
const quoted = (file: string): string =>
  `"${file.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Writes the profile that `sandbox-exec` takes: writes are denied except under the writable paths, and the network is
 * denied unless it is open.
 * @param policy - What the process may do.
 * @returns The profile text.
 */
function profile(policy: Policy): string {
  const writes = policy.writable.map((file) => `(subpath ${quoted(file)})`);
  const kept = policy.readable.map((file) => `(subpath ${quoted(file)})`);
  const logs = (policy.appendable ?? []).map(
    (file) => `(literal ${quoted(file)})`,
  );
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/(tty|pty)[a-z0-9]*$") ${writes.join(" ")})`,
    ...(kept.length > 0 ? [`(deny file-write* ${kept.join(" ")})`] : []),
    ...(logs.length > 0 ? [`(allow file-write* ${logs.join(" ")})`] : []),
    ...(policy.network === "open" ? [] : ["(deny network*)"]),
  ].join("\n");
}

/**
 * Builds the command line that runs a command inside the sandbox.
 * @param backend - The sandbox tool.
 * @param command - The executable and its arguments.
 * @param policy - What the process may do. `provider-only` is refused: no backend can enforce a host allowlist.
 * @returns The vector to spawn. For `bwrap`, in this order: every namespace unshared (the network shared unless it is
 *   off), `/` bound read-only, a tmpfs over each masked directory, the exposed paths bound back read-only, a fresh `/dev`
 *   and `/proc`, the writable paths, the read-only ones, and last the files that are writable inside them. For
 *   `sandbox-exec` it is a profile with the same writable set, which hides nothing.
 * @throws {Error} For `provider-only`.
 */
export function wrap(
  backend: Backend,
  command: string[],
  policy: Policy,
): string[] {
  if (policy.network === "provider-only") {
    throw new Error("the sandbox cannot enforce provider-only");
  }
  if (backend === SANDBOX_EXEC) {
    return [SANDBOX_EXEC, "-p", profile(policy), ...command];
  }
  return [
    BWRAP,
    "--die-with-parent",
    "--unshare-all",
    ...(policy.network === "open" ? ["--share-net"] : []),
    ...["--ro-bind", "/", "/"],
    ...(policy.masked ?? []).flatMap((dir) => ["--tmpfs", dir]),
    ...(policy.exposed ?? []).flatMap((file) => ["--ro-bind", file, file]),
    ...["--dev", "/dev", "--proc", "/proc"],
    ...policy.writable.flatMap((file) => ["--bind", file, file]),
    ...policy.readable.flatMap((file) => ["--ro-bind", file, file]),
    ...(policy.appendable ?? []).flatMap((file) => ["--bind", file, file]),
    "--",
    ...command,
  ];
}

/**
 * Puts a harness command inside the sandbox when the run asks for one.
 * @param sandbox - What the run asks for; absent for a run with no sandbox.
 * @param command - The harness's executable and arguments.
 * @param command.bin - The harness's executable.
 * @param command.args - Its arguments.
 * @param dirs - The run's directories.
 * @param dirs.workspace - The directory the agent works in.
 * @param dirs.home - The throwaway home.
 * @param dirs.mcp - The mock server directory, which stays read-only.
 * @returns The executable and arguments to spawn, and the variables to add to the process's environment: `TMPDIR`, the
 *   run's own temp directory, which is writable.
 */
export function confine(
  sandbox: Confinement | undefined,
  command: { bin: string; args: string[] },
  dirs: { workspace: string; home: string; mcp?: string | undefined },
): { bin: string; args: string[]; env: Record<string, string> } {
  if (sandbox === undefined) return { ...command, env: {} };
  const tmp = sandbox.tmp === undefined ? [] : [sandbox.tmp];
  const { masked, exposed, appendable } = sandbox;
  const [bin = "", ...args] = wrap(
    sandbox.backend,
    [command.bin, ...command.args],
    {
      writable: [
        dirs.workspace,
        dirs.home,
        ...tmp,
        ...(sandbox.writable ?? []),
      ],
      readable: dirs.mcp === undefined ? [] : [dirs.mcp],
      network: sandbox.network,
      masked,
      exposed,
      appendable,
    },
  );
  return {
    bin,
    args,
    env: sandbox.tmp === undefined ? {} : { TMPDIR: sandbox.tmp },
  };
}
