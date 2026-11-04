/**
 * The PortWatcher (CONTRACT.md 8.7, 2.1 rows 181-182): a main-side fiber that scans the user's
 * listening TCP ports, attributes each to the session whose agent marker is innermost in its
 * process ancestry, and records `server_seen` once a port has held its ServerKey for the hold time
 * and `server_gone` when a ledger entry's ServerKey no longer listens in a successful scan. A
 * `conduit server mark` runs the same scan and records `server_seen{declared}` at once. It compares each scan
 * against the ledger's Servers, read in the write that appends the evidence, never against a copy;
 * its own state is the hold candidates and first-scan readiness, in memory. A failed scan records
 * nothing. SessionActivity reads the Servers each write leaves from the Run Ledger's hand-over.
 *
 * Gap (CONTRACT.md 2976): "One PortWatcher per daemon". Servers live in each project's own store,
 * so this runs once per project relay, each recording only its own store's sessions.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { Clock, Config, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { EventPayloadMap } from "../../../contracts/stored-event.js";
import * as Failure from "../../../effect/failure-classification.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type {
	ServerKey,
	TaskKey,
} from "../../../provider/run-ledger/run-ledger-model.js";
import { Subprocess } from "../../daemon/Services/subprocess.js";

class PortScanError extends Data.TaggedError("PortScanError")<{
	readonly reason: string;
	readonly cause?: unknown;
}> {}

interface Scanned {
	readonly sessionId: string;
	readonly server: ServerKey;
	readonly command: string;
	readonly cwd: string;
	readonly taskKey?: TaskKey;
}

/** A Claude background task's stdout file (8.7): `.../tasks/<task id>.output`. */
const TASK_OUTPUT = /\/tasks\/([^/]+)\.output$/;

/**
 * A mark (8.7 Declared): `conduit server mark` names its caller by the CLI's pid; Codex's mark
 * tool by the session of the runner that answered it.
 */
export type MarkRequest = {
	readonly port: number;
	readonly role: "serving" | "awaited";
} & ({ readonly pid: number } | { readonly sessionId: string });

/** Not this store's caller, recorded, or refused with the reason the CLI prints. */
export type MarkOutcome =
	| { readonly kind: "unclaimed" }
	| { readonly kind: "marked" }
	| { readonly kind: "rejected"; readonly reason: string };

// A daemon's projects share one SqlClient, so each registry holds a watcher per project id.

/** Each project's mark (8.7 Declared), run through the watcher's own scan and write. */
export const portWatcherMark = new WeakMap<
	SqlClient.SqlClient,
	Map<string, (request: MarkRequest) => Effect.Effect<MarkOutcome, unknown>>
>();

/** Each project's readiness (8.7): true once a successful scan and one hold have passed. */
export const portWatcherKnown = new WeakMap<
	SqlClient.SqlClient,
	Map<string, () => boolean>
>();

/** Holds `value` as the project's entry until the watcher's scope closes. */
const registerWatcher = <T>(
	registry: WeakMap<SqlClient.SqlClient, Map<string, T>>,
	sql: SqlClient.SqlClient,
	projectId: string,
	value: T,
) =>
	Effect.acquireRelease(
		Effect.sync(() =>
			registry.set(
				sql,
				(registry.get(sql) ?? new Map<string, T>()).set(projectId, value),
			),
		),
		() =>
			Effect.sync(() => {
				if (registry.get(sql)?.get(projectId) === value)
					registry.get(sql)?.delete(projectId);
			}),
	);

const keyOf = (key: ServerKey) => `${key.pid}:${key.startedAt}:${key.port}`;
// 8.7 markers: Claude's carries the Conduit id; Codex's thread id and OpenCode's session id (stamped
// by the managed plugin's shell.env hook, beside the instance's own id) resolve through the binding.
const MARKER =
	/(?:^|\s)(CONDUIT_SESSION_ID|CODEX_THREAD_ID|CONDUIT_OPENCODE_SESSION_ID|CONDUIT_OPENCODE_INSTANCE_ID)=(\S+)/g;
const AGENT_MARKERS = [
	"CONDUIT_SESSION_ID",
	"CODEX_THREAD_ID",
	"CONDUIT_OPENCODE_SESSION_ID",
] as const;
const PS_ROW =
	/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

const PS_TREE =
	/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

/**
 * Linux scans /proc (proc(5)); other hosts run lsof and ps. "lsof" selects lsof and ps (read as "",
 * since Config takes an empty value as unset); tests point it at a fixture tree.
 */
const procRoot = Config.String("CONDUIT_PORT_WATCH_PROC_ROOT").pipe(
	Config.withDefault(process.platform === "linux" ? "/proc" : "lsof"),
	Config.map((root) => (root === "lsof" ? "" : root)),
);
/** /proc start times count USER_HZ ticks, 100 a second on every architecture (proc(5)). */
const USER_HZ = 100;
// Each root's boot time, read once: btime is derived from the clock and can shift a second
// between reads, which would give a running process a new ServerKey.
const bootTimes = new Map<string, number>();
const isPid = (name: string) => /^\d+$/.test(name);
/** A process's file, or undefined once it has exited or cannot be read (another user's). */
const procFile = <A>(read: Promise<A>) =>
	read.catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" || error.code === "ESRCH" || error.code === "EACCES"
			? undefined
			: Promise.reject(error),
	);
const readProc = <A>(what: string, read: () => Promise<A>) =>
	Effect.tryPromise({
		try: read,
		catch: (cause) =>
			cause instanceof PortScanError
				? cause
				: new PortScanError({ reason: `/proc ${what}`, cause }),
	});

/**
 * The process table from /proc: `stat` for the parent, group, state and start time (whole seconds,
 * as ps's lstart), `cmdline` for the command. A process gone mid-read is left out.
 */
const procTable = (root: string) =>
	readProc("process table", async () => {
		const boot =
			bootTimes.get(root) ??
			Number(
				/^btime (\d+)$/m.exec(await readFile(join(root, "stat"), "utf8"))?.[1],
			);
		if (!Number.isInteger(boot))
			throw new PortScanError({ reason: "/proc stat has no btime" });
		bootTimes.set(root, boot);
		const procs = new Map<
			number,
			{
				ppid: number;
				pgid: number;
				zombie: boolean;
				startedAt: number;
				command: string;
			}
		>();
		// One process at a time: a table of thousands must not hold thousands of files open.
		for (const name of (await readdir(root)).filter(isPid)) {
			const stat = await procFile(readFile(join(root, name, "stat"), "utf8"));
			const cmdline = await procFile(
				readFile(join(root, name, "cmdline"), "utf8"),
			);
			if (stat === undefined) continue;
			// The command name sits in parentheses and may hold either; fields resume after the last.
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).split(" ");
			const ticks = Number(fields[19]);
			if (close < 0 || !Number.isInteger(ticks))
				throw new PortScanError({ reason: `/proc ${name}/stat malformed` });
			procs.set(Number(name), {
				ppid: Number(fields[1]),
				pgid: Number(fields[2]),
				zombie: fields[0] === "Z",
				startedAt: (boot + Math.floor(ticks / USER_HZ)) * 1000,
				// A kernel thread or zombie has no cmdline; ps shows its name.
				command:
					cmdline?.replace(/\0+$/, "").replaceAll("\0", " ") ||
					stat.slice(stat.indexOf("(") + 1, close),
			});
		}
		return procs;
	});

/**
 * A /proc net/tcp{,6} local address (hex, each 32-bit word little-endian) as the address to
 * connect to: a wildcard listener is reached on loopback, an IPv4-mapped one as IPv4.
 */
const procHost = (hex: string) => {
	const bytes = (hex.match(/.{8}/g) ?? []).flatMap((word) =>
		(word.match(/../g) ?? [])
			.reverse()
			.map((byte) => Number.parseInt(byte, 16)),
	);
	const ipv4 = (four: number[]) =>
		four.every((byte) => byte === 0) ? "127.0.0.1" : four.join(".");
	if (bytes.length === 4) return ipv4(bytes);
	if (
		bytes.slice(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff
	)
		return ipv4(bytes.slice(12));
	if (bytes.every((byte) => byte === 0)) return "::1";
	return Array.from({ length: 8 }, (_, i) =>
		(((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0)).toString(16),
	).join(":");
};

/**
 * The user's listening TCP sockets (port, and the address that reaches it) by pid, from /proc: `net/tcp` and `net/tcp6` rows in state LISTEN
 * (0A) owned by `uid`, matched to the processes whose fds name the socket's inode. A socket no
 * readable process holds is left out, as lsof leaves out what it cannot see.
 */
const procListening = (root: string, uid: number) =>
	readProc("listening sockets", async () => {
		const ports = new Map<string, { port: number; host: string }>();
		for (const table of ["tcp", "tcp6"]) {
			const text = await readFile(join(root, "net", table), "utf8").catch(
				// A kernel without IPv6 has no tcp6.
				(error: NodeJS.ErrnoException) =>
					table === "tcp6" && error.code === "ENOENT"
						? ""
						: Promise.reject(error),
			);
			for (const line of text.split("\n").slice(1)) {
				if (line.trim() === "") continue;
				const row =
					/^\s*\d+:\s+([\dA-F]+):([\dA-F]{4})\s+[\dA-F]+:[\dA-F]{4}\s+([\dA-F]{2})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\d+\s+(\d+)\s/.exec(
						line,
					);
				if (!row)
					throw new PortScanError({
						reason: `/proc net/${table} line ${line}`,
					});
				if (row[3] === "0A" && Number(row[4]) === uid)
					ports.set(row[5] ?? "", {
						port: Number.parseInt(row[2] ?? "", 16),
						host: procHost(row[1] ?? ""),
					});
			}
		}
		const byPid = new Map<number, { port: number; host: string }[]>();
		if (ports.size === 0) return byPid;
		for (const name of (await readdir(root)).filter(isPid))
			for (const fd of (await procFile(readdir(join(root, name, "fd")))) ??
				[]) {
				const link = await procFile(readlink(join(root, name, "fd", fd)));
				const socket = ports.get(
					/^socket:\[(\d+)\]$/.exec(link ?? "")?.[1] ?? "",
				);
				if (socket !== undefined)
					byPid.set(Number(name), [...(byPid.get(Number(name)) ?? []), socket]);
			}
		return byPid;
	});

export class ServerStopError extends Data.TaggedError("ServerStopError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * The one kill routine (8.7 Stop) for Stop and ended sessions: the server's process group, unless
 * its leader is conduit, a runner host, an agent CLI or a shell, then the server's process tree.
 * SIGTERM, then SIGKILL after 5s. Before each signal it re-reads the process table and sends
 * nothing once the pid no longer has the key's start time. It fails when a signal is refused or
 * the server is still running a second after SIGKILL.
 */
export const killServer = (server: ServerKey) =>
	Effect.gen(function* () {
		const subprocess = yield* Subprocess;
		const root = yield* procRoot;
		// The process table while the key's pid still runs with its start time, else undefined.
		const running = Effect.gen(function* () {
			const procs = new Map<
				number,
				{ ppid: number; pgid: number; startedAt: number; command: string }
			>();
			if (root !== "") {
				for (const [pid, proc] of yield* procTable(root).pipe(
					Effect.mapError(
						(error) =>
							new ServerStopError({
								message: error.reason,
								cause: error.cause,
							}),
					),
				))
					if (!proc.zombie) procs.set(pid, proc);
			} else {
				const { stdout } = yield* subprocess.run(
					"ps",
					["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="],
					{
						timeoutMs: 5000,
						maxBuffer: 16 * 1024 * 1024,
						env: { ...process.env, LC_ALL: "C" },
					},
				);
				for (const line of stdout.split("\n")) {
					const row = PS_TREE.exec(line);
					// An exited child its parent has not reaped yet is not running.
					if (row && !row[4]?.startsWith("Z"))
						procs.set(Number(row[1]), {
							ppid: Number(row[2]),
							pgid: Number(row[3]),
							startedAt: Date.parse(row[5] ?? ""),
							command: row[6] ?? "",
						});
				}
			}
			return procs.get(server.pid)?.startedAt === server.startedAt
				? procs
				: undefined;
		});
		const signal = (name: NodeJS.Signals) =>
			Effect.gen(function* () {
				const procs = yield* running;
				const pgid = procs?.get(server.pid)?.pgid;
				if (procs === undefined || pgid === undefined) return false;
				const leader = procs.get(pgid)?.command;
				const ownGroup =
					leader !== undefined &&
					!/^-?(?:a|ba|c|da|k|tc|z)?sh$|^fish$/.test(
						basename(leader.split(" ")[0] ?? ""),
					) &&
					!/\b(?:conduit|claude|codex|opencode|cursor-agent)\b/.test(leader);
				const tree = [server.pid];
				for (const pid of tree)
					for (const [child, { ppid }] of procs)
						if (ppid === pid && !tree.includes(child)) tree.push(child);
				for (const target of ownGroup ? [-pgid] : tree)
					yield* Effect.try({
						try: () => process.kill(target, name),
						catch: (cause) =>
							new ServerStopError({
								message: `Could not send ${name} to ${target}`,
								cause,
							}),
					}).pipe(
						// Exited since the table was read.
						Effect.catchIf(
							(error) =>
								error.cause instanceof Error &&
								"code" in error.cause &&
								error.cause.code === "ESRCH",
							() => Effect.void,
						),
					);
				return true;
			});
		if (!(yield* signal("SIGTERM"))) return;
		yield* Effect.sleep(5000);
		if (!(yield* signal("SIGKILL"))) return;
		yield* Effect.sleep(1000);
		if ((yield* running) !== undefined)
			return yield* new ServerStopError({
				message: `The server on port ${server.port} is still running after SIGKILL`,
			});
	});

/**
 * The ServerKey listening on `port` now and the address that reaches it, or undefined: the user's
 * earliest-started listener, as a scan names one entry per port (8.7). The Preview Gate reads it before each upstream connection.
 */
export const listenerOn = (port: number) =>
	Effect.gen(function* () {
		const subprocess = yield* Subprocess;
		const root = yield* procRoot;
		const uid = process.getuid?.() ?? 0;
		const started = new Map<number, number>();
		// The address each pid listens on, so the gate reaches the listener it checked.
		const hosts = new Map<number, string>();
		if (root !== "") {
			const procs = yield* procTable(root);
			for (const [pid, sockets] of yield* procListening(root, uid)) {
				const startedAt = procs.get(pid)?.startedAt;
				const socket = sockets.find((socket) => socket.port === port);
				if (socket !== undefined && startedAt !== undefined) {
					started.set(pid, startedAt);
					hosts.set(pid, socket.host);
				}
			}
		} else {
			const options = {
				timeoutMs: 5000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			};
			// lsof exits 1 with no output when nothing listens.
			const { stdout: listening } = yield* subprocess.run(
				"lsof",
				[
					"-nP",
					"-w",
					"-a",
					`-iTCP:${port}`,
					"-sTCP:LISTEN",
					"-u",
					String(uid),
					"-F",
					"ptn",
				],
				options,
			);
			let pid = 0;
			let type = "";
			for (const line of listening.split("\n")) {
				if (line[0] === "p") pid = Number(line.slice(1));
				else if (line[0] === "t") type = line.slice(1);
				else if (line[0] === "n" && !hosts.has(pid)) {
					// n<host>:<port>, the host `*` (wildcard) or bracketed IPv6.
					const host = line
						.slice(1, line.lastIndexOf(":"))
						.replace(/^\[|\]$/g, "");
					hosts.set(
						pid,
						host !== "*" ? host : type === "IPv6" ? "::1" : "127.0.0.1",
					);
				}
			}
			if (hosts.size === 0) return undefined;
			const { stdout } = yield* subprocess.run(
				"ps",
				[
					"-ww",
					"-p",
					[...hosts.keys()].join(","),
					"-o",
					"pid=,ppid=,lstart=,command=",
				],
				options,
			);
			for (const line of stdout.split("\n")) {
				const row = PS_ROW.exec(line);
				if (row) started.set(Number(row[1]), Date.parse(row[3] ?? ""));
			}
		}
		const [pid, startedAt] =
			[...started].sort(([a, at], [b, bt]) => at - bt || a - b)[0] ?? [];
		const host = pid === undefined ? undefined : hosts.get(pid);
		return pid === undefined || startedAt === undefined || host === undefined
			? undefined
			: { server: { pid, startedAt, port } satisfies ServerKey, host };
	});

/** `lsof -F` output as [pid, [fd, name]]; malformed lines fail the scan. */
const lsofFields = (stdout: string) =>
	Effect.gen(function* () {
		const byPid = new Map<number, { fd: string; name: string }[]>();
		let names: { fd: string; name: string }[] | undefined;
		let fd = "";
		for (const line of stdout.split("\n")) {
			if (line === "") continue;
			if (line[0] === "p" && /^p\d+$/.test(line)) {
				names = [];
				fd = "";
				byPid.set(Number(line.slice(1)), names);
			} else if (line[0] === "f" && names !== undefined) fd = line.slice(1);
			else if (line[0] === "n" && names !== undefined)
				names.push({ fd, name: line.slice(1) });
			else return yield* new PortScanError({ reason: `lsof line ${line}` });
		}
		return byPid;
	});

/**
 * `codexThreadOf` reads the thread a session's Codex identity file holds: a locally created Codex
 * session binds no native id in SQL, and its provider is the account's id, not "codex".
 */
export const makePortWatcherLive = (
	codexThreadOf: (sessionId: string) => string | undefined,
) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* EventStoreEffectTag;
			const commit = yield* makeCommitAndSignal;
			const subprocess = yield* Subprocess;
			const intervalMs = yield* Config.Int(
				"CONDUIT_PORT_WATCH_INTERVAL_MS",
			).pipe(Config.withDefault(2000));
			const holdMs = yield* Config.Int("CONDUIT_PORT_WATCH_HOLD_MS").pipe(
				Config.withDefault(10_000),
			);
			const uid = process.getuid?.() ?? 0;
			const root = yield* procRoot;
			/**
			 * Exit 0 output; any other exit, stderr or spawn failure fails the scan. `missing` lets exit 1
			 * stand for "found nothing" (empty) or "found some" (partial: a listed pid exited meanwhile).
			 */
			const run = (
				command: string,
				args: readonly string[],
				missing?: "empty" | "partial",
			) =>
				subprocess
					.run(command, args, {
						// Scans are every interval; a stuck tool fails its scan, never the next one.
						timeoutMs: Math.max(2000, intervalMs * 5),
						priority: "background",
						// Every project's watcher wakes on the same interval grid, so one scan serves all.
						key: `port-watcher ${command} ${args.join(" ")}`,
						maxBuffer: 16 * 1024 * 1024,
						env: { ...process.env, LC_ALL: "C" },
					})
					.pipe(
						Effect.mapError(
							(cause) => new PortScanError({ reason: cause.reason, cause }),
						),
						Effect.flatMap((result) =>
							result.stderr === "" &&
							(result.exitCode === 0 ||
								(result.exitCode === 1 &&
									(missing === "partial" ||
										(missing === "empty" && result.stdout === ""))))
								? Effect.succeed(result.stdout)
								: Effect.fail(
										new PortScanError({
											reason: `${command} exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
										}),
									),
						),
					);

			// A mark scans for its caller's session and its port's listener, marked or not.
			const scan = (mark?: MarkRequest) =>
				Effect.gen(function* () {
					const listening: ReadonlyMap<number, readonly number[]> =
						root !== ""
							? new Map(
									[...(yield* procListening(root, uid))].map(
										([pid, sockets]) => [pid, sockets.map(({ port }) => port)],
									),
								)
							: yield* Effect.gen(function* () {
									// lsof exits 1 with no output when nothing listens.
									const byPid = yield* lsofFields(
										yield* run(
											"lsof",
											[
												"-nP",
												"-w",
												"-a",
												"-iTCP",
												"-sTCP:LISTEN",
												"-u",
												String(uid),
												"-F",
												"pn",
											],
											"empty",
										),
									);
									const ports = new Map<number, number[]>();
									for (const [pid, names] of byPid)
										for (const { name } of names) {
											const port = Number(/:(\d+)$/.exec(name)?.[1]);
											if (!Number.isInteger(port) || port <= 0)
												return yield* new PortScanError({
													reason: `lsof name ${name}`,
												});
											ports.set(pid, [...(ports.get(pid) ?? []), port]);
										}
									return ports;
								});
					const none = new Map<number, ServerKey>();
					if (listening.size === 0 && mark === undefined)
						return { scanned: [], servers: none };
					const procs: ReadonlyMap<
						number,
						{ ppid: number; startedAt: number; command: string }
					> =
						root !== ""
							? yield* procTable(root)
							: yield* Effect.gen(function* () {
									const table = new Map<
										number,
										{ ppid: number; startedAt: number; command: string }
									>();
									for (const line of (yield* run("ps", [
										"-axww",
										"-o",
										"pid=,ppid=,lstart=,command=",
									])).split("\n")) {
										if (line.trim() === "") continue;
										const row = PS_ROW.exec(line);
										const startedAt = row
											? Date.parse(row[3] ?? "")
											: Number.NaN;
										if (!row || Number.isNaN(startedAt))
											return yield* new PortScanError({
												reason: `ps line ${line}`,
											});
										table.set(Number(row[1]), {
											ppid: Number(row[2]),
											startedAt,
											command: row[4] ?? "",
										});
									}
									return table;
								});
					// 8.7: one entry per port, the earliest-started process; one process's IPv4 and IPv6
					// listeners are one server. A pid gone since lsof listed it is not listening.
					const servers = new Map<number, ServerKey>();
					for (const [pid, ports] of listening) {
						const proc = procs.get(pid);
						if (proc === undefined) continue;
						for (const port of ports) {
							const held = servers.get(port);
							if (
								held === undefined ||
								proc.startedAt < held.startedAt ||
								(proc.startedAt === held.startedAt && pid < held.pid)
							)
								servers.set(port, { pid, startedAt: proc.startedAt, port });
						}
					}
					const chainOf = (pid: number) => {
						const chain: number[] = [];
						for (let at = pid; at > 1 && !chain.includes(at); ) {
							chain.push(at);
							at = procs.get(at)?.ppid ?? 0;
						}
						return chain;
					};
					const target = mark && servers.get(mark.port);
					const chainPids = new Set([
						...[...servers.values()].flatMap((server) => chainOf(server.pid)),
						...(mark && "pid" in mark ? chainOf(mark.pid) : []),
					]);
					// Each chain process's environment as text: /proc's environ, or ps -E's line, where a
					// platform binary's environment is not visible but an ancestor's is.
					const environments: ReadonlyMap<number, string> =
						root !== ""
							? yield* readProc("environ", async () => {
									const texts = new Map<number, string>();
									for (const pid of chainPids) {
										const text = await procFile(
											readFile(join(root, String(pid), "environ"), "utf8"),
										);
										if (text !== undefined)
											texts.set(pid, text.replaceAll("\0", "\n"));
									}
									return texts;
								})
							: new Map(
									(yield* run("ps", [
										"-wwE",
										"-p",
										[...chainPids].join(","),
										"-o",
										"pid=,command=",
									]))
										.split("\n")
										.map((line) => [
											Number(/^\s*(\d+)\s/.exec(line)?.[1]),
											line,
										]),
								);
					const envs = new Map<number, ReadonlyMap<string, string>>();
					for (const [pid, line] of environments) {
						const env = new Map(
							[...line.matchAll(MARKER)].map(([, name = "", value = ""]) => [
								name,
								value,
							]),
						);
						if (AGENT_MARKERS.some((name) => env.has(name))) envs.set(pid, env);
					}
					// A Codex thread's session in any project (they share this store, as a
					// CONDUIT_SESSION_ID marker names its session in any project): the binding's native
					// id, else an open session whose Codex identity holds the thread (any account; none or
					// several: unattributed).
					// A malformed identity file is no thread, never a failed scan.
					const readThread = (sessionId: string) => {
						try {
							return codexThreadOf(sessionId);
						} catch {
							return undefined;
						}
					};
					const codexSession = (thread: string) =>
						sql<{ id: string; sid: string | null }>`SELECT session.id,
						COALESCE(binding.provider_sid, session.provider_sid) AS sid
					FROM sessions AS session
					LEFT JOIN session_providers AS binding ON binding.id = (
						SELECT id FROM session_providers WHERE session_id = session.id AND status = 'active'
						ORDER BY activated_at DESC, id DESC LIMIT 1)
					WHERE (COALESCE(binding.provider_sid, session.provider_sid) = ${thread}
							OR (COALESCE(binding.provider_sid, session.provider_sid) IS NULL
								AND session.settled_at IS NULL AND session.archived_at IS NULL))`.pipe(
							Effect.mapError(
								(cause) =>
									new PortScanError({ reason: "marker lookup", cause }),
							),
							Effect.map((rows) => {
								const owners = rows.filter(
									({ id, sid }) => sid === thread || readThread(id) === thread,
								);
								return owners.length === 1 ? owners[0]?.id : undefined;
							}),
						);
					// The innermost agent set the marker whose value holds for the fewest marked ancestors.
					const resolve = (pid: number) => {
						const chain = chainOf(pid).flatMap((at) => envs.get(at) ?? []);
						const inner = chain[0];
						if (inner === undefined) return Effect.void;
						const reach = (name: string) => {
							const changed = chain.findIndex(
								(env) => env.get(name) !== inner.get(name),
							);
							return changed < 0 ? chain.length : changed;
						};
						const [name] = AGENT_MARKERS.filter((marker) =>
							inner.has(marker),
						).sort((a, b) => reach(a) - reach(b));
						const id = inner.get(name ?? "") ?? "";
						if (name === "CONDUIT_SESSION_ID") return Effect.succeed(id);
						if (name === "CODEX_THREAD_ID") return codexSession(id);
						const provider = inner.get("CONDUIT_OPENCODE_INSTANCE_ID");
						if (provider === undefined) return Effect.void;
						// The binding's native id within its provider (as findOpenCodeSession reads it), in
						// any project; none or several sessions leave the server unattributed.
						return sql<{
							id: string;
						}>`SELECT session.id FROM sessions AS session
					LEFT JOIN session_providers AS binding ON binding.id = (
						SELECT id FROM session_providers WHERE session_id = session.id AND status = 'active'
						ORDER BY activated_at DESC, id DESC LIMIT 1)
					WHERE COALESCE(binding.provider, session.provider) = ${provider}
						AND COALESCE(binding.provider_sid, session.provider_sid, session.id) = ${id}
					LIMIT 2`.pipe(
							Effect.map((rows) =>
								rows.length === 1 ? rows[0]?.id : undefined,
							),
							Effect.mapError(
								(cause) =>
									new PortScanError({ reason: "marker lookup", cause }),
							),
						);
					};
					const marked: { server: ServerKey; sessionId: string }[] = [];
					for (const server of servers.values()) {
						const sessionId = yield* resolve(server.pid);
						if (sessionId !== undefined) marked.push({ server, sessionId });
					}
					const caller =
						mark && ("pid" in mark ? yield* resolve(mark.pid) : mark.sessionId);
					if (marked.length === 0 && target === undefined)
						return { scanned: [], servers, caller };
					const markedPids = [
						...new Set([
							...marked.map(({ server }) => server.pid),
							...(target ? [target.pid] : []),
						]),
					];
					const cwds: ReadonlyMap<
						number,
						readonly { fd: string; name: string }[]
					> =
						root !== ""
							? yield* readProc("cwd", async () => {
									const files = new Map<
										number,
										{ fd: string; name: string }[]
									>();
									for (const pid of markedPids) {
										const at = join(root, String(pid));
										const cwd = await procFile(readlink(join(at, "cwd")));
										const stdout = await procFile(
											readlink(join(at, "fd", "1")),
										);
										files.set(pid, [
											...(cwd === undefined ? [] : [{ fd: "cwd", name: cwd }]),
											...(stdout === undefined
												? []
												: [{ fd: "1", name: stdout }]),
										]);
									}
									return files;
								})
							: yield* lsofFields(
									yield* run(
										"lsof",
										[
											"-nP",
											"-w",
											"-a",
											"-d",
											"cwd,1",
											"-p",
											markedPids.join(","),
											"-F",
											"pn",
										],
										"partial",
									),
								);
					const describe = (server: ServerKey): Omit<Scanned, "sessionId"> => {
						const fds = cwds.get(server.pid) ?? [];
						const taskId = TASK_OUTPUT.exec(
							fds.find(({ fd }) => fd === "1")?.name ?? "",
						)?.[1];
						return {
							server,
							command: procs.get(server.pid)?.command ?? "",
							cwd: fds.find(({ fd }) => fd === "cwd")?.name ?? "",
							...(taskId === undefined ? {} : { taskKey: { taskId } }),
						};
					};
					// 8.7 Task link (CONTRACT.md 2988-2989): a server no task output file links goes to the
					// one terminal its session's latest snapshot lists with the server's cwd and a command
					// its process chain runs, bare or under a shell's -c. None or several leave it
					// session-level. Only Codex terminals carry a cwd.
					const linked = (scanned: Scanned) =>
						scanned.taskKey !== undefined
							? Effect.succeed(scanned)
							: sql<{ data: string }>`SELECT data FROM events
								WHERE session_id = ${scanned.sessionId} AND type = 'evidence.tasks_snapshot'
								ORDER BY sequence DESC LIMIT 1`.pipe(
									Effect.mapError(
										(cause) =>
											new PortScanError({ reason: "task link lookup", cause }),
									),
									Effect.map(([row]) => {
										const commands = chainOf(scanned.server.pid).map(
											(pid) => procs.get(pid)?.command ?? "",
										);
										const matches = (
											row
												? (
														JSON.parse(
															row.data,
														) as EventPayloadMap["evidence.tasks_snapshot"]
													).tasks
												: []
										).filter(
											({ cwd, description }) =>
												cwd === scanned.cwd &&
												commands.some(
													(command) =>
														command === description ||
														command.endsWith(` -c ${description}`) ||
														command.endsWith(` -lc ${description}`),
												),
										);
										const [only] = matches;
										return matches.length === 1 && only
											? { ...scanned, taskKey: only.key }
											: scanned;
									}),
								);
					return {
						scanned: yield* Effect.forEach(marked, ({ server, sessionId }) =>
							linked({ sessionId, ...describe(server) }),
						),
						servers,
						caller,
						target: target && describe(target),
					};
				});

			// Servers of ended sessions this watcher is killing, by key.
			const stopping = new Set<string>();
			// Hold candidates: each port's ServerKey and when this watcher first saw it there.
			const held = new Map<number, { key: string; since: number }>();
			let firstScanAt: number | undefined;
			let known = false;
			const startedAt = yield* Clock.currentTimeMillis;
			// Warn once per run of failures: a host without lsof fails every scan.
			let failing = false;
			yield* registerWatcher(
				portWatcherKnown,
				sql,
				store.projectId,
				() => known,
			);

			// A live server keeps its row Open (8.3) and was recorded by a server_seen, so those rows
			// and the scan's markers name every session a scan or mark can change.
			const sessionsWithServers = (ids: readonly string[]) =>
				sql<{ id: string; provider: string }>`
				SELECT id, provider FROM sessions WHERE project_id = ${store.projectId}
					AND (id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
						OR id IN (SELECT l.session_id FROM run_ledger_sessions l WHERE l.state = 'Open'
							AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = l.session_id
								AND e.type = 'evidence.server_seen')))
				ORDER BY id`;

			// 8.7 Declared: rejected, recording nothing, when nothing listens on the port or the port
			// belongs to another session; recorded at once, skipping the hold. A caller this store
			// cannot resolve is left to the other projects' watchers.
			const mark = (request: MarkRequest) =>
				Effect.gen(function* () {
					const { scanned, caller, target } = yield* scan(request);
					const [owned] =
						caller === undefined
							? []
							: yield* sql<{
									ended: number;
									provider: string;
								}>`SELECT (settled_at IS NOT NULL
								OR archived_at IS NOT NULL
								OR EXISTS (SELECT 1 FROM events WHERE session_id = sessions.id
									AND type = 'session.deleted')) AS ended, provider
								FROM sessions WHERE id = ${caller} AND project_id = ${store.projectId}`;
					if (caller === undefined || owned === undefined)
						return { kind: "unclaimed" } as const;
					const rejected = (reason: string) =>
						({ kind: "rejected", reason }) as const;
					// 8.7: an ended session has no servers; a mark would record one the next scan drops.
					if (owned.ended) return rejected("This session has ended");
					if (target === undefined)
						return rejected(`Nothing is listening on port ${request.port}`);
					const another = rejected(
						`Port ${request.port} belongs to another session`,
					);
					if (
						scanned.some(
							({ server, sessionId }) =>
								server.port === request.port && sessionId !== caller,
						)
					)
						return another;
					const now = yield* Clock.currentTimeMillis;
					return yield* commit.write((project) =>
						Effect.gen(function* () {
							const entryOf = (sessionId: string) =>
								loadLedgerView(sessionId).pipe(
									Effect.map((view) => view?.servers?.get(request.port)),
								);
							// An unmarked server another session declared is that session's, in any project:
							// the daemon's projects share this store. Every owner is checked before the
							// caller's write, which this transaction would commit.
							for (const { id } of yield* sql<{
								id: string;
							}>`SELECT l.session_id AS id FROM run_ledger_sessions l
								WHERE l.state = 'Open' AND l.session_id != ${caller}
									AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = l.session_id
										AND e.type = 'evidence.server_seen')`) {
								const entry = yield* entryOf(id);
								if (
									entry !== undefined &&
									keyOf(entry.key) === keyOf(target.server)
								)
									return another;
							}
							const entry = yield* entryOf(caller);
							// A repeated mark (a model's retry) is already recorded.
							if (
								entry?.source === "declared" &&
								entry.role === request.role &&
								keyOf(entry.key) === keyOf(target.server)
							)
								return { kind: "marked" } as const;
							yield* project(
								yield* store.appendBatch([
									canonicalEvent(
										"evidence.server_seen",
										caller,
										{ ...target, source: "declared", role: request.role },
										{ provider: owned.provider, createdAt: now },
									),
								]),
							);
							return { kind: "marked" } as const;
						}),
					);
				});
			yield* registerWatcher(portWatcherMark, sql, store.projectId, (request) =>
				mark(request).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			);

			const step = Effect.gen(function* () {
				const { scanned, servers: listening } = yield* scan();
				const now = yield* Clock.currentTimeMillis;
				for (const port of held.keys())
					if (!scanned.some((entry) => entry.server.port === port))
						held.delete(port);
				for (const { server } of scanned) {
					const key = keyOf(server);
					if (held.get(server.port)?.key !== key)
						held.set(server.port, { key, since: now });
				}
				yield* commit.write((project) =>
					Effect.gen(function* () {
						const events = [];
						for (const session of yield* sessionsWithServers(
							scanned.map((entry) => entry.sessionId),
						)) {
							const servers = (yield* loadLedgerView(session.id))?.servers;
							const mine = scanned.filter(
								(entry) => entry.sessionId === session.id,
							);
							const meta = { provider: session.provider, createdAt: now };
							// Gone when its ServerKey no longer listens, so an unmarked server a mark
							// declared stays while it listens (8.7 Declared).
							for (const entry of servers?.values() ?? []) {
								const live = listening.get(entry.key.port);
								if (live === undefined || keyOf(live) !== keyOf(entry.key))
									events.push(
										canonicalEvent(
											"evidence.server_gone",
											session.id,
											{ server: entry.key },
											meta,
										),
									);
							}
							for (const { server, command, cwd, taskKey } of mine) {
								const entry = servers?.get(server.port);
								const since = held.get(server.port)?.since ?? now;
								if (
									(entry === undefined || keyOf(entry.key) !== keyOf(server)) &&
									now - since >= holdMs
								)
									events.push(
										canonicalEvent(
											"evidence.server_seen",
											session.id,
											{
												server,
												command,
												cwd,
												...(taskKey === undefined ? {} : { taskKey }),
												source: "detected",
											},
											meta,
										),
									);
							}
						}
						if (events.length > 0)
							yield* project(yield* store.appendBatch(events));
					}),
				);
				// 8.7: ended sessions have no servers. Only this store's sessions count, so a marker
				// this daemon cannot resolve is never read as ended; the hold does not apply.
				const ended = yield* sql<{ id: string }>`
				SELECT value AS id FROM json_each(${JSON.stringify(scanned.map((entry) => entry.sessionId))})
					WHERE value IN (SELECT id FROM sessions WHERE project_id = ${store.projectId}
							AND (settled_at IS NOT NULL OR archived_at IS NOT NULL))
						OR EXISTS (SELECT 1 FROM events WHERE session_id = value
							AND type = 'session.deleted' AND project_id = ${store.projectId})`;
				for (const { sessionId, server } of scanned) {
					const key = keyOf(server);
					if (stopping.has(key) || !ended.some((row) => row.id === sessionId))
						continue;
					stopping.add(key);
					yield* killServer(server).pipe(
						Effect.provideService(Subprocess, subprocess),
						Effect.catchCause((cause) =>
							Effect.logWarning("PortWatcher could not stop a server", cause),
						),
						Effect.ensuring(Effect.sync(() => stopping.delete(key))),
						Effect.forkScoped,
					);
				}
				firstScanAt ??= now;
				known ||= now - firstScanAt >= holdMs;
				failing = false;
			}).pipe(
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.interrupt
						: Effect.gen(function* () {
								// CONTRACT.md 2987-2988 ("auto-settle waits") is silent on a host with no
								// working scanner (no lsof, or no readable /proc): when every scan fails through the
								// first hold, servers read as absent rather than holding auto-settle forever.
								const now = yield* Clock.currentTimeMillis;
								known ||=
									firstScanAt === undefined && now - startedAt >= holdMs;
								if (failing) return;
								failing = true;
								yield* Effect.logWarning("PortWatcher scan failed", cause);
							}),
				),
				Effect.andThen(
					Effect.flatMap(Clock.currentTimeMillis, (now) =>
						Effect.sleep(intervalMs - (now % intervalMs)),
					),
				),
			);
			yield* Effect.forkScoped(Effect.forever(step));
		}),
	);
