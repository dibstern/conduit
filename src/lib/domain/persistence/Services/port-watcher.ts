/**
 * The PortWatcher (CONTRACT.md 8.7, 2.1 rows 181-182): a main-side fiber that scans the user's
 * listening TCP ports, attributes each to the session whose agent marker is innermost in its
 * process ancestry, and records `server_seen` once a port has held its ServerKey for the hold time
 * and `server_gone` when a ledger entry's ServerKey no longer listens in a successful scan. A
 * `conduit server mark` runs the same scan and records `server_seen{declared}` at once. It compares each scan
 * against the ledger's Servers, read in the write that appends the evidence, never against a copy;
 * its own state is the hold candidates and first-scan readiness, in memory. A failed scan records
 * nothing. After each write it hands SessionActivity the Servers that write left.
 *
 * Gap (CONTRACT.md 2976): "One PortWatcher per daemon". Servers live in each project's own store,
 * so this runs once per project relay, each recording only its own store's sessions.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { Clock, Config, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import * as Failure from "../../../effect/failure-classification.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type {
	ServerKey,
	Servers,
	TaskKey,
} from "../../../provider/run-ledger/run-ledger-model.js";
import type { SessionServer } from "../../../shared-types.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
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

/**
 * A Claude background task's stdout file (8.7): `.../tasks/<task id>.output`.
 * Codex's link (CONTRACT.md 2988-2989, a unique command and cwd match in
 * `thread/backgroundTerminals/list`) waits for that snapshot (CONTRACT.md 2791, 32.21);
 * until then Codex servers are session-level.
 */
const TASK_OUTPUT = /\/tasks\/([^/]+)\.output$/;

/** A `conduit server mark` (8.7 Declared): the CLI's pid names the caller's session. */
export interface MarkRequest {
	readonly pid: number;
	readonly port: number;
	readonly role: "serving" | "awaited";
}

/** Not this store's caller, recorded, or refused with the reason the CLI prints. */
export type MarkOutcome =
	| { readonly kind: "unclaimed" }
	| { readonly kind: "marked" }
	| { readonly kind: "rejected"; readonly reason: string };

/** Each store's mark (8.7 Declared), run through the watcher's own scan and write. */
export const portWatcherMark = new WeakMap<
	SqlClient.SqlClient,
	(request: MarkRequest) => Effect.Effect<MarkOutcome, unknown>
>();

/** Each store's readiness (8.7): true once a successful scan and one hold have passed. */
export const portWatcherKnown = new WeakMap<
	SqlClient.SqlClient,
	() => boolean
>();

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
 * Linux scans /proc (proc(5)); other hosts run lsof and ps. "" selects lsof and ps; tests point it at
 * a fixture tree.
 */
const procRoot = Config.String("CONDUIT_PORT_WATCH_PROC_ROOT").pipe(
	Config.withDefault(process.platform === "linux" ? "/proc" : ""),
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
 * The user's listening TCP ports by pid, from /proc: `net/tcp` and `net/tcp6` rows in state LISTEN
 * (0A) owned by `uid`, matched to the processes whose fds name the socket's inode. A socket no
 * readable process holds is left out, as lsof leaves out what it cannot see.
 */
const procListening = (root: string, uid: number) =>
	readProc("listening sockets", async () => {
		const ports = new Map<string, number>();
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
					/^\s*\d+:\s+[\dA-F]+:([\dA-F]{4})\s+[\dA-F]+:[\dA-F]{4}\s+([\dA-F]{2})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\d+\s+(\d+)\s/.exec(
						line,
					);
				if (!row)
					throw new PortScanError({
						reason: `/proc net/${table} line ${line}`,
					});
				if (row[2] === "0A" && Number(row[3]) === uid)
					ports.set(row[4] ?? "", Number.parseInt(row[1] ?? "", 16));
			}
		}
		const byPid = new Map<number, number[]>();
		if (ports.size === 0) return byPid;
		for (const name of (await readdir(root)).filter(isPid))
			for (const fd of (await procFile(readdir(join(root, name, "fd")))) ??
				[]) {
				const link = await procFile(readlink(join(root, name, "fd", fd)));
				const port = ports.get(
					/^socket:\[(\d+)\]$/.exec(link ?? "")?.[1] ?? "",
				);
				if (port !== undefined)
					byPid.set(Number(name), [...(byPid.get(Number(name)) ?? []), port]);
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
 * The ServerKey listening on `port` now, or undefined: the user's earliest-started listener, as a
 * scan names one entry per port (8.7). The Preview Gate reads it before each upstream connection.
 */
export const listenerOn = (port: number) =>
	Effect.gen(function* () {
		const subprocess = yield* Subprocess;
		const root = yield* procRoot;
		const uid = process.getuid?.() ?? 0;
		const started = new Map<number, number>();
		if (root !== "") {
			const procs = yield* procTable(root);
			for (const [pid, ports] of yield* procListening(root, uid)) {
				const startedAt = procs.get(pid)?.startedAt;
				if (ports.includes(port) && startedAt !== undefined)
					started.set(pid, startedAt);
			}
		} else {
			const options = {
				timeoutMs: 5000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			};
			// lsof exits 1 with no output when nothing listens.
			const pids = (yield* subprocess.run(
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
					"p",
				],
				options,
			)).stdout.match(/^p\d+$/gm);
			if (pids === null) return undefined;
			const { stdout } = yield* subprocess.run(
				"ps",
				[
					"-ww",
					"-p",
					pids.map((pid) => pid.slice(1)).join(","),
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
		return pid === undefined || startedAt === undefined
			? undefined
			: ({ pid, startedAt, port } satisfies ServerKey);
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

export const PortWatcherLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const subprocess = yield* Subprocess;
		const activity = yield* SessionActivityTag;
		const intervalMs = yield* Config.Int("CONDUIT_PORT_WATCH_INTERVAL_MS").pipe(
			Config.withDefault(2000),
		);
		const holdMs = yield* Config.Int("CONDUIT_PORT_WATCH_HOLD_MS").pipe(
			Config.withDefault(10_000),
		);
		const uid = process.getuid?.() ?? 0;
		const root = yield* procRoot;
		/** Exit 0 output; any other exit, stderr or spawn failure fails the scan. */
		const run = (command: string, args: readonly string[], empty = false) =>
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
							(empty && result.exitCode === 1 && result.stdout === ""))
							? Effect.succeed(result.stdout)
							: Effect.fail(
									new PortScanError({
										reason: `${command} exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
									}),
								),
					),
				);

		// A mark scans for its caller's session and its port's listener, marked or not.
		const scan = (mark?: Pick<MarkRequest, "pid" | "port">) =>
			Effect.gen(function* () {
				const listening: ReadonlyMap<number, readonly number[]> =
					root !== ""
						? yield* procListening(root, uid)
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
										true,
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
									const startedAt = row ? Date.parse(row[3] ?? "") : Number.NaN;
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
					...(mark ? chainOf(mark.pid) : []),
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
									.map((line) => [Number(/^\s*(\d+)\s/.exec(line)?.[1]), line]),
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
					const provider =
						name === "CODEX_THREAD_ID"
							? "codex"
							: inner.get("CONDUIT_OPENCODE_INSTANCE_ID");
					if (provider === undefined) return Effect.void;
					// The binding's native id within its provider (as findOpenCodeSession reads it);
					// none or several sessions here leave the server unattributed.
					return sql<{ id: string }>`SELECT session.id FROM sessions AS session
					LEFT JOIN session_providers AS binding ON binding.id = (
						SELECT id FROM session_providers WHERE session_id = session.id AND status = 'active'
						ORDER BY activated_at DESC, id DESC LIMIT 1)
					WHERE session.project_id = ${store.projectId}
						AND COALESCE(binding.provider, session.provider) = ${provider}
						AND COALESCE(binding.provider_sid, session.provider_sid, session.id) = ${id}
					LIMIT 2`.pipe(
						Effect.map((rows) => (rows.length === 1 ? rows[0]?.id : undefined)),
						Effect.mapError(
							(cause) => new PortScanError({ reason: "marker lookup", cause }),
						),
					);
				};
				const marked: { server: ServerKey; sessionId: string }[] = [];
				for (const server of servers.values()) {
					const sessionId = yield* resolve(server.pid);
					if (sessionId !== undefined) marked.push({ server, sessionId });
				}
				const caller = mark && (yield* resolve(mark.pid));
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
								const files = new Map<number, { fd: string; name: string }[]>();
								for (const pid of markedPids) {
									const at = join(root, String(pid));
									const cwd = await procFile(readlink(join(at, "cwd")));
									const stdout = await procFile(readlink(join(at, "fd", "1")));
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
								yield* run("lsof", [
									"-nP",
									"-w",
									"-a",
									"-d",
									"cwd,1",
									"-p",
									markedPids.join(","),
									"-F",
									"pn",
								]),
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
				return {
					scanned: marked.map(
						({ server, sessionId }): Scanned => ({
							sessionId,
							...describe(server),
						}),
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
		const published = new Set<string>();
		portWatcherKnown.set(sql, () => known);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => portWatcherKnown.delete(sql)),
		);

		type Stamp = Parameters<Parameters<typeof commit.write>[0]>[1];
		// Readers see the Servers a write left. The copy moves before COMMIT, so a reader woken by
		// the write's advance already sees it; a rolled-back write is corrected by the next scan.
		const publish = (
			read: ReadonlyMap<string, Servers | undefined>,
			stamp: Stamp,
		) =>
			Effect.gen(function* () {
				for (const [id, servers] of read)
					if (servers?.size) published.add(id);
					else published.delete(id);
				const moved = [...read].flatMap(([sessionId, servers]) => {
					const list = [...(servers?.values() ?? [])].map(
						({ key, command, cwd, taskKey, source, role }): SessionServer => {
							// The Preview Gate's link, while the gate serves the port.
							const gateUrl = activity.gateUrls.get(key.port);
							return {
								port: key.port,
								pid: key.pid,
								startedAt: key.startedAt,
								command,
								cwd,
								...(taskKey === undefined ? {} : { taskId: taskKey.taskId }),
								source,
								role,
								...(gateUrl === undefined ? {} : { gateUrl }),
							};
						},
					);
					if (
						JSON.stringify(activity.servers.get(sessionId) ?? []) ===
						JSON.stringify(list)
					)
						return [];
					if (list.length === 0) activity.servers.delete(sessionId);
					else activity.servers.set(sessionId, list);
					return [sessionId];
				});
				// The sidebar applies servers at read time, so its row's version moves for the
				// shell feed to re-read it.
				if (moved.length > 0)
					yield* stamp((version) =>
						sql<{
							session_id: string;
						}>`UPDATE session_sidebar SET version = ${version}
							WHERE row IS NOT NULL AND session_id IN (SELECT COALESCE(root_id, id) FROM sessions
								WHERE id IN (SELECT value FROM json_each(${JSON.stringify(moved)})))
							RETURNING session_id`.pipe(
							Effect.map((rows) => rows.map(({ session_id }) => session_id)),
						),
					);
				return moved;
			});
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
				const owned =
					caller === undefined
						? []
						: yield* sql<{ id: string }>`SELECT id FROM sessions
								WHERE id = ${caller} AND project_id = ${store.projectId}`;
				if (caller === undefined || owned.length === 0)
					return { kind: "unclaimed" } as const;
				const rejected = (reason: string) =>
					({ kind: "rejected", reason }) as const;
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
				const outcome = yield* commit.write((project, stamp) =>
					Effect.gen(function* () {
						const read = new Map<string, Servers | undefined>();
						for (const session of yield* sessionsWithServers([caller])) {
							const servers = (yield* loadLedgerView(session.id))?.servers;
							const entry = servers?.get(request.port);
							// An unmarked server another session declared is that session's.
							if (
								session.id !== caller &&
								entry !== undefined &&
								keyOf(entry.key) === keyOf(target.server)
							)
								return { outcome: another, moved: [] };
							if (session.id !== caller) continue;
							yield* project(
								yield* store.appendBatch([
									canonicalEvent(
										"evidence.server_seen",
										caller,
										{ ...target, source: "declared", role: request.role },
										{ provider: session.provider, createdAt: now },
									),
								]),
							);
							read.set(caller, (yield* loadLedgerView(caller))?.servers);
						}
						return {
							outcome: { kind: "marked" } as const,
							moved: yield* publish(read, stamp),
						};
					}),
				);
				for (const sessionId of outcome.moved) activity.changed(sessionId);
				return outcome.outcome;
			});
		portWatcherMark.set(sql, (request) =>
			mark(request).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
		);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => portWatcherMark.delete(sql)),
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
			const moved = yield* commit.write((project, stamp) =>
				Effect.gen(function* () {
					const read = new Map<string, Servers | undefined>();
					const events = [];
					for (const session of yield* sessionsWithServers(
						scanned.map((entry) => entry.sessionId),
					)) {
						const servers = (yield* loadLedgerView(session.id))?.servers;
						read.set(session.id, servers);
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
					for (const sessionId of new Set(
						events.map((event) => event.sessionId),
					))
						read.set(sessionId, (yield* loadLedgerView(sessionId))?.servers);
					// A session no longer read has none.
					for (const sessionId of published)
						if (!read.has(sessionId)) read.set(sessionId, undefined);
					return yield* publish(read, stamp);
				}),
			);
			for (const sessionId of moved) activity.changed(sessionId);
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
							known ||= firstScanAt === undefined && now - startedAt >= holdMs;
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
