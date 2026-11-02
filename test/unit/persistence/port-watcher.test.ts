// The PortWatcher (CONTRACT.md 8.7, 8.2) against real SQLite, the arm and real subprocesses: a fake
// lsof and ps on PATH for the failure cases, the real ones for a real node server. How it could fail:
// 1. lsof is missing (spawn fails), and the failed scan reads as "no servers", recording server_gone;
// 2. lsof times out, and the same;
// 3. lsof's output is partial (a truncated name line), and the parsed half reads as the whole scan;
// 4. lsof reports a permission error, and the listeners it did print read as the whole scan;
// 5. a pid is reused, or its start time differs, on a port it already holds, and the entry is
//    silently swapped instead of server_gone then server_seen;
// 6. a port changes hands to another process, and the same;
// 7. a port held under the hold time records server_seen;
// 8. the outermost marker in the ancestry wins, an unmarked port is recorded, or a marker naming no
//    session of this store is recorded;
// 9. one process's IPv4 and IPv6 listeners make two entries, or two processes on one port keep the
//    later-started;
// 10. after a restart the watcher records server_seen again for a server already in the ledger, or
//     never records server_gone for one that died while it was down;
// 11. servers read as known before the first successful scan and one hold;
// 12. a host whose every scan fails (no lsof) never reads as known, so auto-settle waits forever.
// 13. a server whose stdout is a Claude task's output file is not linked to that task, or a server
//     whose stdout is a terminal, another file, a `.output` file outside `tasks/`, or closed is.
// 14. a Codex shell's server (CODEX_THREAD_ID, the native thread id) is not attributed to the
//     session whose Codex binding holds that thread, or a native id is read as a Conduit id.
// 15. an OpenCode shell's server (CONDUIT_OPENCODE_SESSION_ID with CONDUIT_OPENCODE_INSTANCE_ID) is
//     not attributed to the session that instance binds to the native id, or another instance's
//     session with the same native id gets it.
// 16. a native marker no session here resolves (an unknown thread, another instance, an OpenCode
//     marker without its instance) is attributed or fails the scan instead of being ignored.
// 17. with agents nested (Claude inside a Codex shell, Codex inside a Claude shell), the outer
//     agent's marker wins over the innermost one.
// On Linux the watcher reads /proc instead; the tests marked "both" run against a fixture /proc tree
// of the same world too (the real-server test covers real /proc on Linux CI). How /proc could fail:
// 18. a socket read wrong: one not listening, another user's, an unowned inode, or one process's
//     IPv4 and IPv6 sockets as two servers;
// 19. a start time unequal to ps's (raw ticks, or not from the boot time), so the keys differ;
// 20. a command not joined from cmdline, or an environment marker split wrong;
// 21. /proc missing, or a malformed socket table, read as "no servers";
// 22. a process exiting mid-scan, or one whose fds cannot be read, failing the scan.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { beforeEach, expect } from "vitest";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	PortWatcherLive,
	portWatcherKnown,
} from "../../../src/lib/domain/persistence/Services/port-watcher.js";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const INTERVAL_MS = 20;
const HOLD_MS = 100;

/** Which scanner the watcher uses: the fake lsof and ps, the fixture /proc tree, or the host's own. */
let scanner: "lsof" | "proc" | "host" = "lsof";
/** The fixture boot time (/proc/stat btime), in seconds. */
const BTIME = Date.parse("Mon Nov  2 07:00:00 2026") / 1000;

/**
 * A fake lsof and ps reading their answers from files in their own directory, and the same world as
 * a /proc tree (proc(5)) at `<dir>/proc`, each version written whole and swapped in by a symlink
 * rename so a scan never reads half of one.
 */
const fakeTools = (dir: string) => {
	let procs: readonly Proc[] = [];
	let listeners: Listeners = [];
	let generation = 0;
	const render = () => {
		const root = join(dir, `proc.${++generation}`);
		mkdirSync(join(root, "net"), { recursive: true });
		writeFileSync(join(root, "stat"), `cpu  1 2 3 4\nbtime ${BTIME}\n`);
		for (const p of procs) {
			const at = join(root, String(p.pid));
			mkdirSync(join(at, "fd"), { recursive: true });
			const ticks = (Date.parse(p.lstart) / 1000 - BTIME) * 100 + 37;
			// comm may hold spaces and parentheses; the fields after its last ")" are read.
			writeFileSync(
				join(at, "stat"),
				`${p.pid} (${p.command.split(" ")[0]} (x)) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 10\n`,
			);
			writeFileSync(
				join(at, "cmdline"),
				`${p.command.split(" ").join("\0")}\0`,
			);
			writeFileSync(
				join(at, "environ"),
				[
					"HOME=/Users/u",
					...(p.marker ? [`CONDUIT_SESSION_ID=${p.marker}`] : []),
					...(p.env?.split(" ") ?? []),
				]
					.map((entry) => `${entry}\0`)
					.join(""),
			);
			symlinkSync(`/work/${p.pid}`, join(at, "cwd"));
			if (p.stdout !== undefined) symlinkSync(p.stdout, join(at, "fd", "1"));
		}
		const uid = process.getuid?.() ?? 0;
		const header =
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
		const tables = { tcp: [header], tcp6: [header] };
		for (const [i, [pid, ...names]] of listeners.entries())
			for (const [j, name] of names.entries()) {
				const inode = 7000 + i * 10 + j;
				const port = Number(/:(\d+)$/.exec(name)?.[1])
					.toString(16)
					.toUpperCase()
					.padStart(4, "0");
				const table = name.startsWith("[") ? tables.tcp6 : tables.tcp;
				const any = name.startsWith("[") ? "0".repeat(32) : "00000000";
				table.push(
					`  ${table.length - 1}: ${any}:${port} ${any}:0000 0A 00000000:00000000 00:00000000 00000000 ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`,
				);
				// A listener whose process is not in the table has no fd entry, as one that has exited.
				if (existsSync(join(root, String(pid))))
					symlinkSync(
						`socket:[${inode}]`,
						join(root, String(pid), "fd", String(10 + j)),
					);
			}
		writeFileSync(join(root, "net", "tcp"), tables.tcp.join(""));
		writeFileSync(join(root, "net", "tcp6"), tables.tcp6.join(""));
		symlinkSync(root, join(dir, "proc.next"));
		renameSync(join(dir, "proc.next"), join(dir, "proc"));
	};
	const script = (pick: string) => `#!/bin/sh
d=$(/usr/bin/dirname "$0")
${pick}
echo "$kind" >> "$d/calls"
if [ -f "$d/$kind.once" ]; then /bin/cat "$d/$kind.once"; /bin/rm "$d/$kind.once"; exit 0; fi
[ -f "$d/$kind.sleep" ] && /bin/sleep "$(/bin/cat "$d/$kind.sleep")"
[ -f "$d/$kind.err" ] && /bin/cat "$d/$kind.err" >&2
[ -f "$d/$kind.out" ] && /bin/cat "$d/$kind.out"
exit "$(/bin/cat "$d/$kind.rc" 2>/dev/null || echo 0)"
`;
	const install = (name: string, pick: string) => {
		writeFileSync(join(dir, name), script(pick));
		chmodSync(join(dir, name), 0o755);
	};
	// Over /proc the scan runs no tool, so none is on PATH.
	if (scanner !== "proc") {
		install("lsof", 'case "$*" in *cwd*) kind=cwd;; *) kind=listen;; esac');
		install("ps", 'case "$*" in *E*) kind=env;; *) kind=table;; esac');
	}
	return {
		show: (shown: { procs?: readonly Proc[]; listeners?: Listeners }) => {
			procs = shown.procs ?? procs;
			listeners = shown.listeners ?? listeners;
			render();
		},
		/** The current /proc tree's file. */
		proc: (file: string) => join(dir, "proc", file),
		/** Takes the scanner's host source away: lsof, or /proc. */
		breakHost: () =>
			rmSync(join(dir, scanner === "proc" ? "proc" : "lsof"), { force: true }),
		set: (file: string, content: string | undefined) =>
			content === undefined
				? rmSync(join(dir, file), { force: true })
				: writeFileSync(join(dir, file), content),
		/** Listen scans begun so far (lsof): scan n is complete, write included, once scan n + 1 begins. */
		scans: () =>
			readFileSync(join(dir, "calls"), { encoding: "utf8", flag: "a+" })
				.split("\n")
				.filter((line) => line === "listen").length,
		has: (file: string) => existsSync(join(dir, file)),
	};
};
type Fake = ReturnType<typeof fakeTools>;
type Listeners = readonly (readonly [number, ...string[]])[];

const T = {
	agent: "Mon Nov  2 08:00:00 2026",
	shell: "Mon Nov  2 08:00:01 2026",
	server: "Mon Nov  2 08:00:02 2026",
	later: "Mon Nov  2 08:30:00 2026",
} as const;
const at = (lstart: string) => Date.parse(lstart);

interface Proc {
	readonly pid: number;
	readonly ppid: number;
	readonly lstart: string;
	readonly command: string;
	readonly marker?: string;
	/** What lsof names as fd 1, when it is open. */
	readonly stdout?: string;
	/** Further environment ps -E shows, as `NAME=value` words. */
	readonly env?: string;
}
/**
 * The world: s1's agent (500) runs a shell (501) that runs a node server (600, its env not visible,
 * as for a platform binary) and an inner agent marked s2 (510) running vite (610); an unmarked
 * process (900); a process marked with a session this store does not know (910).
 */
const world: readonly Proc[] = [
	{ pid: 500, ppid: 1, lstart: T.agent, command: "claude", marker: "s1" },
	{ pid: 501, ppid: 500, lstart: T.shell, command: "/bin/zsh -c npm run dev" },
	{ pid: 600, ppid: 501, lstart: T.server, command: "node server.js" },
	{ pid: 510, ppid: 501, lstart: T.shell, command: "claude", marker: "s2" },
	{ pid: 610, ppid: 510, lstart: T.server, command: "vite --port 5173" },
	{ pid: 900, ppid: 1, lstart: T.agent, command: "python -m http.server" },
	{ pid: 910, ppid: 1, lstart: T.agent, command: "node x", marker: "nope" },
];
const showWorld = (fake: Fake, procs: readonly Proc[]) => {
	fake.set(
		"table.out",
		procs
			.map((p) => `${p.pid} ${p.ppid} ${p.lstart}     ${p.command}\n`)
			.join(""),
	);
	fake.set(
		"env.out",
		procs
			.map(
				(p) =>
					`${p.pid} ${p.command} HOME=/Users/u${p.marker ? ` CONDUIT_SESSION_ID=${p.marker}` : ""}${p.env ? ` ${p.env}` : ""}\n`,
			)
			.join(""),
	);
	fake.set(
		"cwd.out",
		procs
			.map(
				(p) =>
					`p${p.pid}\nfcwd\nn/work/${p.pid}\n${p.stdout === undefined ? "" : `f1\nn${p.stdout}\n`}`,
			)
			.join(""),
	);
	fake.show({ procs });
};
/** lsof -F pn output, and /proc/net/tcp and tcp6 rows, for [pid, ...names]. */
const showListeners = (fake: Fake, listeners: Listeners) => {
	fake.set(
		"listen.out",
		listeners
			.map(
				([pid, ...names]) =>
					`p${pid}\n${names.map((name, i) => `f${10 + i}\nn${name}\n`).join("")}`,
			)
			.join(""),
	);
	fake.set("listen.rc", listeners.length === 0 ? "1" : undefined);
	fake.show({ listeners });
};

/** The watcher's timing, and its scanner: "" for lsof and ps, a /proc root, or the host default. */
const config = (intervalMs: number, holdMs: number, procRoot: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			CONDUIT_PORT_WATCH_INTERVAL_MS: String(intervalMs),
			CONDUIT_PORT_WATCH_HOLD_MS: String(holdMs),
			...(scanner === "host"
				? {}
				: { CONDUIT_PORT_WATCH_PROC_ROOT: scanner === "proc" ? procRoot : "" }),
		}),
	);

/** One store over the file with the watcher running until the body ends (a restart's unit). */
const open = <A, E>(
	file: string,
	body: (
		commit: CommitAndSignal,
	) => Effect.Effect<A, E, PersistenceEffectContext | SessionActivityTag>,
	[intervalMs, holdMs] = [INTERVAL_MS, HOLD_MS],
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* Layer.build(PortWatcherLive);
			return yield* body(commit);
		}),
	).pipe(
		Effect.provide(
			Layer.mergeAll(
				makePersistenceEffectLayer(file, "test-project"),
				config(intervalMs, holdMs, join(dirname(file), "bin", "proc")),
				Layer.effect(SessionActivityTag, makeSessionActivity),
			),
		),
	);

/** A temp dir with the fake tools first on PATH (only them, unless `realPath`). */
const withDir = <A, E, R>(
	body: (dir: string, fake: Fake) => Effect.Effect<A, E, R>,
	realPath = false,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const dir = mkdtempSync(join(tmpdir(), "port-watcher-"));
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const path = process.env["PATH"];
			if (!realPath) process.env["PATH"] = bin;
			return { dir, bin, path };
		}),
		({ dir, bin }) => body(dir, fakeTools(bin)),
		({ dir, path }) =>
			Effect.sync(() => {
				process.env["PATH"] = path;
				rmSync(dir, { recursive: true, force: true });
			}),
	);

/** Waits on the live clock until `ready` holds. */
const until = (ready: () => boolean) =>
	Effect.gen(function* () {
		while (!ready()) yield* Effect.sleep(5);
	}).pipe(Effect.timeout("8 seconds"));
/** Waits until `n` more scans have completed; a /proc scan leaves no trace, so there it waits n + 2 intervals. */
const scans = (fake: Fake, n: number) => {
	if (scanner === "proc") return Effect.sleep(INTERVAL_MS * (n + 2));
	const start = fake.scans();
	return until(() => fake.scans() >= start + n + 1);
};

const serverEvents = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{
		session_id: string;
		type: string;
		data: string;
	}>`SELECT session_id, type, data FROM events WHERE type LIKE 'evidence.server_%'
		ORDER BY sequence`;
	return rows.map((row) => ({
		session: row.session_id,
		type: row.type.slice("evidence.".length),
		...(JSON.parse(row.data) as { readonly server?: unknown }),
	}));
});
/** Polls the events until `count` server events are stored. */
const eventsUntil = (count: number) =>
	Effect.gen(function* () {
		for (;;) {
			const events = yield* serverEvents;
			if (events.length >= count) return events;
			yield* Effect.sleep(5);
		}
	}).pipe(Effect.timeout("8 seconds"));
const serversOf = (sessionId: string) =>
	loadLedgerView(sessionId).pipe(
		Effect.map((view) => [...(view?.servers?.values() ?? [])]),
	);

const sessions = (commit: CommitAndSignal) =>
	commit(
		["s1", "s2"].map((id) =>
			makeSessionCreatedEvent(id, { provider: "claude", createdAt: 100 }),
		),
	);

const seen600 = {
	session: "s1",
	type: "server_seen",
	server: { pid: 600, startedAt: at(T.server), port: 3000 },
	command: "node server.js",
	cwd: "/work/600",
	source: "detected",
};
const gone600 = {
	session: "s1",
	type: "server_gone",
	server: seen600.server,
};

/** s1's server on 3000 already in the ledger; then `fail` breaks the scan for a few scans. */
const failedScanKeeps = (
	fail: (fake: Fake) => void,
	wait: (fake: Fake) => Effect.Effect<unknown, unknown>,
) =>
	withDir((dir, fake) =>
		open(join(dir, "events.db"), (commit) =>
			Effect.gen(function* () {
				yield* sessions(commit);
				showWorld(fake, world);
				showListeners(fake, [[600, "*:3000"]]);
				yield* eventsUntil(1);
				fail(fake);
				yield* wait(fake);
				return {
					events: yield* serverEvents,
					servers: yield* serversOf("s1"),
				};
			}),
		),
	).pipe(
		Effect.tap(({ events, servers }) =>
			Effect.sync(() => {
				expect(events).toEqual([seen600]);
				expect(servers.map((server) => server.key)).toEqual([seen600.server]);
			}),
		),
	);

describe("PortWatcher, lsof and ps only", () => {
	beforeEach(() => {
		scanner = "lsof";
	});
	it.live(
		"2: an lsof timeout records nothing and removes nothing",
		() =>
			failedScanKeeps(
				(fake) => fake.set("listen.sleep", "4"),
				(fake) => scans(fake, 1),
			),
		10_000,
	);

	it.live("3: partial lsof output records nothing and removes nothing", () =>
		failedScanKeeps(
			(fake) => fake.set("listen.out", "p600\nf12\nn*:"),
			(fake) => scans(fake, 3),
		),
	);

	it.live(
		"4: an lsof permission error records nothing and removes nothing",
		() =>
			failedScanKeeps(
				(fake) => {
					fake.set("listen.out", "p901\nf3\nn*:4444\n");
					fake.set("listen.err", "lsof: can't stat: Permission denied\n");
					fake.set("listen.rc", "1");
				},
				(fake) => scans(fake, 3),
			),
	);
});

describe.each(["lsof", "proc"] as const)("PortWatcher over %s", (mode) => {
	beforeEach(() => {
		scanner = mode;
	});

	it.live(
		"1, 21: a missing lsof or /proc records nothing and removes nothing",
		() =>
			failedScanKeeps(
				(fake) => fake.breakHost(),
				() => Effect.sleep(HOLD_MS * 3),
			),
	);

	it.live(
		"5, 6: a reused pid or a new process on a held port is server_gone then server_seen",
		() =>
			withDir((dir, fake) =>
				open(join(dir, "events.db"), (commit) =>
					Effect.gen(function* () {
						yield* sessions(commit);
						showWorld(fake, world);
						showListeners(fake, [[600, "*:3000"]]);
						yield* eventsUntil(1);
						// 5: pid 600 again, started later: a new ServerKey on the port.
						showWorld(fake, [
							...world.filter((p) => p.pid !== 600),
							{ ...world[2], lstart: T.later } as Proc,
						]);
						yield* eventsUntil(3);
						// 6: another process takes the port.
						showWorld(fake, [
							...world,
							{
								pid: 601,
								ppid: 501,
								lstart: T.later,
								command: "node next.js",
							},
						]);
						showListeners(fake, [[601, "*:3000"]]);
						const events = yield* eventsUntil(5);
						// SessionActivity gets the write's Servers after its commit.
						const activity = yield* SessionActivityTag;
						yield* until(() => activity.servers.get("s1")?.[0]?.pid === 601);
						return {
							events,
							servers: yield* serversOf("s1"),
							published: activity.servers.get("s1"),
						};
					}),
				),
			).pipe(
				Effect.tap(({ events, servers, published }) =>
					Effect.sync(() => {
						expect(published).toEqual([
							{
								port: 3000,
								pid: 601,
								startedAt: at(T.later),
								command: "node next.js",
								cwd: "/work/601",
								source: "detected",
								role: "serving",
							},
						]);
						const reused = { pid: 600, startedAt: at(T.later), port: 3000 };
						const next = { pid: 601, startedAt: at(T.later), port: 3000 };
						expect(events).toEqual([
							seen600,
							gone600,
							{ ...seen600, server: reused },
							{ ...gone600, server: reused },
							{
								...seen600,
								server: next,
								command: "node next.js",
								cwd: "/work/601",
							},
						]);
						expect(servers.map((server) => server.key)).toEqual([next]);
					}),
				),
			),
	);

	it.live(
		"13: a server writing to a Claude task's output file is linked to that task; any other stdout is session-level",
		() =>
			withDir((dir, fake) =>
				open(join(dir, "events.db"), (commit) =>
					Effect.gen(function* () {
						yield* sessions(commit);
						const tasks = "/private/tmp/claude-501/-w/s1/tasks";
						const shellChild = (pid: number, command: string): Proc => ({
							pid,
							ppid: 501,
							lstart: T.server,
							command,
						});
						showWorld(fake, [
							...world.filter((p) => p.pid !== 600),
							{
								...shellChild(600, "node server.js"),
								stdout: `${tasks}/b1x2.output`,
							},
							{ ...shellChild(601, "a"), stdout: "/dev/ttys003" },
							{ ...shellChild(602, "b"), stdout: "/w/log.output" },
							shellChild(603, "c"),
						]);
						showListeners(fake, [
							[600, "*:3000"],
							[601, "*:3001"],
							[602, "*:3002"],
							[603, "*:3003"],
						]);
						yield* eventsUntil(4);
						return yield* serversOf("s1");
					}),
				),
			).pipe(
				Effect.tap((servers) =>
					Effect.sync(() => {
						expect(
							servers
								.map(({ key, taskKey }) => [key.port, taskKey])
								.sort(([a], [b]) => Number(a) - Number(b)),
						).toEqual([
							[3000, { taskId: "b1x2" }],
							[3001, undefined],
							[3002, undefined],
							[3003, undefined],
						]);
					}),
				),
			),
	);

	it.live(
		"14, 15, 16, 17: Codex and OpenCode markers resolve through their provider binding; unresolvable ones are ignored; the innermost agent wins",
		() =>
			withDir((dir, fake) =>
				open(join(dir, "events.db"), (commit) =>
					Effect.gen(function* () {
						yield* sessions(commit);
						const native = (id: string, provider: string, sid: string) =>
							canonicalEvent(
								"session.created",
								id,
								{ sessionId: id, title: id, provider, providerSessionId: sid },
								{ createdAt: 100 },
							);
						yield* commit([
							native("c1", "codex", "thread-c"),
							native("o1", "inst-a", "ses_native"),
							native("o2", "inst-c", "ses_native"),
						]);
						const proc = (
							pid: number,
							ppid: number,
							command: string,
							env?: string,
							marker?: string,
						): Proc => ({
							pid,
							ppid,
							lstart: T.server,
							command,
							...(env === undefined ? {} : { env }),
							...(marker === undefined ? {} : { marker }),
						});
						const codex = "CODEX_THREAD_ID=thread-c";
						const opencode = (instance: string) =>
							`CONDUIT_OPENCODE_INSTANCE_ID=${instance} CONDUIT_OPENCODE_SESSION_ID=ses_native`;
						showWorld(fake, [
							proc(700, 1, "codex app-server"),
							proc(701, 700, "zsh", codex),
							proc(702, 701, "node a.js"),
							proc(
								720,
								1,
								"opencode serve",
								"CONDUIT_OPENCODE_INSTANCE_ID=inst-a",
							),
							proc(721, 720, "bash", opencode("inst-a")),
							proc(722, 721, "node b.js"),
							proc(731, 1, "bash", opencode("inst-b")),
							proc(732, 731, "node c.js"),
							proc(741, 1, "bash", "CODEX_THREAD_ID=thread-unknown"),
							proc(742, 741, "node d.js"),
							proc(746, 1, "bash", "CONDUIT_OPENCODE_SESSION_ID=ses_native"),
							proc(747, 746, "node e.js"),
							proc(750, 1, "zsh", codex),
							proc(751, 750, "claude", codex, "s2"),
							proc(752, 751, "node f.js", codex, "s2"),
							proc(760, 1, "zsh", undefined, "s1"),
							proc(761, 760, "codex", undefined, "s1"),
							proc(762, 761, "zsh", codex, "s1"),
							proc(763, 762, "node g.js"),
						]);
						showListeners(fake, [
							[702, "*:4000"],
							[722, "*:4001"],
							[732, "*:4002"],
							[742, "*:4003"],
							[747, "*:4006"],
							[752, "*:4004"],
							[763, "*:4005"],
						]);
						yield* eventsUntil(4);
						const ports = (id: string) =>
							serversOf(id).pipe(
								Effect.map((servers) =>
									servers.map(({ key }) => key.port).sort(),
								),
							);
						return {
							c1: yield* ports("c1"),
							o1: yield* ports("o1"),
							o2: yield* ports("o2"),
							s1: yield* ports("s1"),
							s2: yield* ports("s2"),
						};
					}),
				),
			).pipe(
				Effect.tap((ports) =>
					Effect.sync(() => {
						expect(ports).toEqual({
							c1: [4000, 4005],
							o1: [4001],
							o2: [],
							s1: [],
							s2: [4004],
						});
					}),
				),
			),
	);

	it.live(
		"7, 8, 9: the hold, the innermost marker, one entry per port, unmarked and unknown ignored",
		() =>
			withDir((dir, fake) =>
				open(join(dir, "events.db"), (commit) =>
					Effect.gen(function* () {
						yield* sessions(commit);
						showWorld(fake, [
							...world,
							{ pid: 620, ppid: 501, lstart: T.later, command: "later" },
							{ pid: 621, ppid: 501, lstart: T.server, command: "earlier" },
							{ pid: 630, ppid: 501, lstart: T.server, command: "brief" },
						]);
						// 7: 630 holds 7000 for one scan only. The hold is the scanner's caller's, so
						// one scanner proves it; a /proc scan leaves no trace to time "one scan" by.
						if (scanner === "lsof") {
							fake.set("listen.once", "p630\nf10\nn*:7000\n");
							yield* until(() => !fake.has("listen.once"));
						}
						showListeners(fake, [
							[600, "*:3000", "[::1]:3000", "127.0.0.1:3000"],
							[610, "[::1]:5173"],
							[620, "*:4000"],
							[621, "*:4000"],
							[900, "*:8080"],
							[910, "*:9090"],
						]);
						const events = yield* eventsUntil(3);
						// Several more holds: nothing else is recorded.
						yield* Effect.sleep(HOLD_MS * 3);
						return {
							events,
							after: yield* serverEvents,
							s1: yield* serversOf("s1"),
							s2: yield* serversOf("s2"),
						};
					}),
				),
			).pipe(
				Effect.tap(({ events, after, s1, s2 }) =>
					Effect.sync(() => {
						expect(after).toEqual(events);
						expect(
							[...events].sort((a, b) =>
								JSON.stringify(a).localeCompare(JSON.stringify(b)),
							),
						).toEqual([
							seen600,
							{
								...seen600,
								server: { pid: 621, startedAt: at(T.server), port: 4000 },
								command: "earlier",
								cwd: "/work/621",
							},
							{
								session: "s2",
								type: "server_seen",
								server: { pid: 610, startedAt: at(T.server), port: 5173 },
								command: "vite --port 5173",
								cwd: "/work/610",
								source: "detected",
							},
						]);
						expect(s1.map((server) => server.key.port).sort()).toEqual([
							3000, 4000,
						]);
						expect(s2.map((server) => server.key.port)).toEqual([5173]);
					}),
				),
			),
	);

	it.live(
		"10, 11: a restart reads the ledger's servers, corrects them on its first scan, and is unknown until a hold",
		() =>
			withDir((dir, fake) =>
				Effect.gen(function* () {
					const file = join(dir, "events.db");
					showWorld(fake, world);
					showListeners(fake, [
						[600, "*:3000"],
						[610, "*:5173"],
					]);
					yield* open(file, (commit) =>
						Effect.gen(function* () {
							yield* sessions(commit);
							yield* eventsUntil(2);
						}),
					);
					// Down: 610 exits. Up again with 600 still listening.
					showListeners(fake, [[600, "*:3000"]]);
					return yield* open(file, () =>
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							const known = portWatcherKnown.get(sql);
							const before = known?.();
							const events = yield* eventsUntil(3);
							yield* until(() => known?.() === true);
							yield* scans(fake, 2);
							const activity = yield* SessionActivityTag;
							return {
								published: [...activity.servers.keys()],
								before,
								events,
								after: yield* serverEvents,
								s1: yield* serversOf("s1"),
								s2: yield* serversOf("s2"),
							};
						}),
					);
				}),
			).pipe(
				Effect.tap(({ published, before, events, after, s1, s2 }) =>
					Effect.sync(() => {
						expect(published).toEqual(["s1"]);
						expect(before).toBe(false);
						expect(events.at(-1)).toMatchObject({
							session: "s2",
							type: "server_gone",
							server: { pid: 610, port: 5173 },
						});
						expect(after).toEqual(events);
						expect(s1.map((server) => server.key)).toEqual([seen600.server]);
						expect(s2).toEqual([]);
					}),
				),
			),
	);

	it.live(
		"12: a host whose every scan fails reads as known once the first hold has passed",
		() =>
			withDir((dir, fake) => {
				fake.breakHost();
				return open(join(dir, "events.db"), () =>
					Effect.gen(function* () {
						const known = portWatcherKnown.get(yield* SqlClient.SqlClient);
						const before = known?.();
						const started = Date.now();
						yield* until(() => known?.() === true);
						return { before, waited: Date.now() - started };
					}),
				);
			}).pipe(
				Effect.tap(({ before, waited }) =>
					Effect.sync(() => {
						expect(before).toBe(false);
						expect(waited).toBeGreaterThanOrEqual(HOLD_MS - INTERVAL_MS);
					}),
				),
			),
	);
});

describe("PortWatcher over /proc", () => {
	beforeEach(() => {
		scanner = "proc";
	});
	it.live(
		"21: a malformed socket table records nothing and removes nothing",
		() =>
			failedScanKeeps(
				(fake) => appendFileSync(fake.proc("net/tcp"), "   9: 0100007F:1F\n"),
				() => Effect.sleep(HOLD_MS * 3),
			),
	);

	it.live(
		"18, 22: only the user's listening sockets count; an unowned socket, an exited process and unreadable fds are skipped, not failures",
		() =>
			withDir((dir, fake) =>
				Effect.gen(function* () {
					const child = (pid: number): Proc => ({
						pid,
						ppid: 501,
						lstart: T.server,
						command: `node ${pid}.js`,
					});
					showWorld(fake, [...world, child(602), child(603)]);
					showListeners(fake, [
						[600, "*:3000", "[::1]:3000"],
						[602, "*:3002"],
						[603, "*:3003"],
					]);
					const uid = process.getuid?.() ?? 0;
					const row = (
						port: number,
						state: string,
						owner: number,
						inode: number,
					) =>
						`  20: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${owner}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
					// 600 also holds an established connection and another user's listener (as a
					// socket passed across users would show); nothing owns inode 9003.
					appendFileSync(
						fake.proc("net/tcp"),
						row(3001, "01", uid, 9001) +
							row(3004, "0A", uid + 1, 9002) +
							row(3005, "0A", uid, 9003),
					);
					symlinkSync("socket:[9001]", fake.proc("600/fd/20"));
					symlinkSync("socket:[9002]", fake.proc("600/fd/21"));
					// 602's fds cannot be read; 603 exited after its directory was listed.
					chmodSync(fake.proc("602/fd"), 0);
					rmSync(fake.proc("603/stat"));
					return yield* open(join(dir, "events.db"), (commit) =>
						Effect.gen(function* () {
							yield* sessions(commit);
							yield* eventsUntil(1);
							yield* Effect.sleep(HOLD_MS * 3);
							return {
								events: yield* serverEvents,
								servers: yield* serversOf("s1"),
							};
						}),
					).pipe(
						Effect.ensuring(
							Effect.sync(() => chmodSync(fake.proc("602/fd"), 0o755)),
						),
					);
				}),
			).pipe(
				Effect.tap(({ events, servers }) =>
					Effect.sync(() => {
						expect(events).toEqual([seen600]);
						expect(servers.map((server) => server.key)).toEqual([
							seen600.server,
						]);
					}),
				),
			),
	);
});

describe("PortWatcher over the host's own scanner", () => {
	beforeEach(() => {
		scanner = "host";
	});
	// Unique per run: real lsof sees every marked server, including a concurrent run's.
	const real = `real-${process.pid}`;
	it.live(
		"a real node server marked with its session is seen after the hold and gone after it exits",
		() =>
			withDir(
				(dir) =>
					open(
						join(dir, "events.db"),
						(commit) =>
							Effect.gen(function* () {
								yield* commit([
									makeSessionCreatedEvent(real, {
										provider: "claude",
										createdAt: 100,
									}),
								]);
								const child = spawn(
									process.execPath,
									[
										"-e",
										'const s=require("http").createServer().listen(0,"127.0.0.1",()=>console.log(s.address().port))',
									],
									{
										cwd: dir,
										env: { ...process.env, CONDUIT_SESSION_ID: real },
										stdio: ["ignore", "pipe", "inherit"],
									},
								);
								// A failed wait must not leave the server running.
								return yield* Effect.gen(function* () {
									const port = yield* Effect.callback<number>((resume) => {
										child.stdout.once("data", (chunk: Buffer) =>
											resume(Effect.succeed(Number(String(chunk).trim()))),
										);
									});
									const seen = yield* eventsUntil(1);
									const servers = yield* serversOf(real);
									child.kill("SIGTERM");
									const events = yield* eventsUntil(2);
									const artifacts = join(import.meta.dirname, "artifacts");
									mkdirSync(artifacts, { recursive: true });
									writeFileSync(
										join(artifacts, "port-watcher-real-server.json"),
										`${JSON.stringify(events, null, "\t")}\n`,
									);
									return {
										dir,
										port,
										pid: child.pid,
										seen,
										servers,
										events,
										after: yield* serversOf(real),
									};
								}).pipe(
									Effect.ensuring(Effect.sync(() => child.kill("SIGKILL"))),
								);
							}),
						[100, 300],
					),
				true,
			).pipe(
				Effect.tap(({ port, pid, seen, servers, events, after }) =>
					Effect.sync(() => {
						expect(seen).toEqual([
							{
								session: real,
								type: "server_seen",
								server: { pid, startedAt: expect.any(Number), port },
								command: expect.stringContaining("http"),
								cwd: expect.stringContaining("port-watcher-"),
								source: "detected",
							},
						]);
						expect(servers.map((server) => server.key.port)).toEqual([port]);
						expect(events[1]).toEqual({
							session: real,
							type: "server_gone",
							server: seen[0]?.server,
						});
						expect(after).toEqual([]);
					}),
				),
			),
		15_000,
	);
});
