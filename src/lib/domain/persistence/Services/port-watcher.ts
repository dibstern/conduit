/**
 * The PortWatcher (CONTRACT.md 8.7, 2.1 rows 181-182): a main-side fiber that scans the user's
 * listening TCP ports, attributes each to the session whose CONDUIT_SESSION_ID is innermost in its
 * process ancestry, and records `server_seen` once a port has held its ServerKey for the hold time
 * and `server_gone` when a ledger entry is missing from a successful scan. It compares each scan
 * against the ledger's Servers, read in the write that appends the evidence, never against a copy;
 * its own state is the hold candidates and first-scan readiness, in memory. A failed scan records
 * nothing. After each write it hands SessionActivity the Servers that write left.
 *
 * Gap (CONTRACT.md 2976): "One PortWatcher per daemon". Servers live in each project's own store,
 * so this runs once per project relay, each recording only its own store's sessions.
 */
import { basename } from "node:path";
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

/** A Claude background task's stdout file (8.7): `.../tasks/<task id>.output`. */
const TASK_OUTPUT = /\/tasks\/([^/]+)\.output$/;

/** Each store's readiness (8.7): true once a successful scan and one hold have passed. */
export const portWatcherKnown = new WeakMap<
	SqlClient.SqlClient,
	() => boolean
>();

const keyOf = (key: ServerKey) => `${key.pid}:${key.startedAt}:${key.port}`;
const MARKER = /(?:^|\s)CONDUIT_SESSION_ID=(\S+)/g;
const PS_ROW =
	/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

const PS_TREE =
	/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

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
		// The process table while the key's pid still runs with its start time, else undefined.
		const running = Effect.gen(function* () {
			const { stdout } = yield* subprocess.run(
				"ps",
				["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="],
				{
					timeoutMs: 5000,
					maxBuffer: 16 * 1024 * 1024,
					env: { ...process.env, LC_ALL: "C" },
				},
			);
			const procs = new Map<
				number,
				{ ppid: number; pgid: number; startedAt: number; command: string }
			>();
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

		const scan = Effect.gen(function* () {
			// lsof exits 1 with no output when nothing listens.
			const listening = yield* lsofFields(
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
			if (listening.size === 0) return [];
			const procs = new Map<
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
					return yield* new PortScanError({ reason: `ps line ${line}` });
				procs.set(Number(row[1]), {
					ppid: Number(row[2]),
					startedAt,
					command: row[4] ?? "",
				});
			}
			// 8.7: one entry per port, the earliest-started process; one process's IPv4 and IPv6
			// listeners are one server. A pid gone since lsof listed it is not listening.
			const servers = new Map<number, ServerKey>();
			for (const [pid, names] of listening) {
				const proc = procs.get(pid);
				if (proc === undefined) continue;
				for (const { name } of names) {
					const port = Number(/:(\d+)$/.exec(name)?.[1]);
					if (!Number.isInteger(port) || port <= 0)
						return yield* new PortScanError({ reason: `lsof name ${name}` });
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
			const chainPids = new Set(
				[...servers.values()].flatMap((server) => chainOf(server.pid)),
			);
			// A platform binary's environment is not visible to ps -E; an ancestor's is.
			const markers = new Map<number, string>();
			for (const line of (yield* run("ps", [
				"-wwE",
				"-p",
				[...chainPids].join(","),
				"-o",
				"pid=,command=",
			])).split("\n")) {
				const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
				const marker = [...line.matchAll(MARKER)].at(-1)?.[1];
				if (marker !== undefined) markers.set(pid, marker);
			}
			const marked = [...servers.values()].flatMap((server) => {
				const owner = chainOf(server.pid).find((pid) => markers.has(pid));
				const sessionId = owner === undefined ? undefined : markers.get(owner);
				return sessionId === undefined ? [] : [{ server, sessionId }];
			});
			if (marked.length === 0) return [];
			const cwds = yield* lsofFields(
				yield* run("lsof", [
					"-nP",
					"-w",
					"-a",
					"-d",
					"cwd,1",
					"-p",
					[...new Set(marked.map(({ server }) => server.pid))].join(","),
					"-F",
					"pn",
				]),
			);
			return marked.map(({ server, sessionId }): Scanned => {
				const fds = cwds.get(server.pid) ?? [];
				const taskId = TASK_OUTPUT.exec(
					fds.find(({ fd }) => fd === "1")?.name ?? "",
				)?.[1];
				return {
					sessionId,
					server,
					command: procs.get(server.pid)?.command ?? "",
					cwd: fds.find(({ fd }) => fd === "cwd")?.name ?? "",
					...(taskId === undefined ? {} : { taskKey: { taskId } }),
				};
			});
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
		let published = new Set<string>();
		portWatcherKnown.set(sql, () => known);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => portWatcherKnown.delete(sql)),
		);

		const step = Effect.gen(function* () {
			const scanned = yield* scan;
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
					// A live server keeps its row Open (8.3) and was recorded by a server_seen, so
					// those rows and the scan's markers name every session this scan can change.
					const sessions = yield* sql<{ id: string; provider: string }>`
						SELECT id, provider FROM sessions WHERE project_id = ${store.projectId}
							AND (id IN (SELECT value FROM json_each(${JSON.stringify(scanned.map((entry) => entry.sessionId))}))
								OR id IN (SELECT l.session_id FROM run_ledger_sessions l WHERE l.state = 'Open'
									AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = l.session_id
										AND e.type = 'evidence.server_seen')))
						ORDER BY id`;
					const read = new Map<string, Servers | undefined>();
					const events = [];
					for (const session of sessions) {
						const servers = (yield* loadLedgerView(session.id))?.servers;
						read.set(session.id, servers);
						const mine = scanned.filter(
							(entry) => entry.sessionId === session.id,
						);
						const meta = { provider: session.provider, createdAt: now };
						for (const entry of servers?.values() ?? [])
							if (!mine.some((scan) => keyOf(scan.server) === keyOf(entry.key)))
								events.push(
									canonicalEvent(
										"evidence.server_gone",
										session.id,
										{ server: entry.key },
										meta,
									),
								);
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
					// Readers see the Servers this write left; a session no longer read has none.
					for (const sessionId of published)
						if (!read.has(sessionId)) read.set(sessionId, undefined);
					published = new Set(
						[...read].flatMap(([id, servers]) => (servers?.size ? [id] : [])),
					);
					// The copy moves before COMMIT, so a reader woken by this write's advance
					// already sees it; a rolled-back write is corrected by the next scan.
					const moved = [...read].flatMap(([sessionId, servers]) => {
						const list = [...(servers?.values() ?? [])].map(
							({
								key,
								command,
								cwd,
								taskKey,
								source,
								role,
							}): SessionServer => ({
								port: key.port,
								pid: key.pid,
								startedAt: key.startedAt,
								command,
								cwd,
								...(taskKey === undefined ? {} : { taskId: taskKey.taskId }),
								source,
								role,
							}),
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
							// working scanner (Linux until /proc): when every scan fails through the
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
