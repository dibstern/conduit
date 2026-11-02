import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { expect } from "vitest";
import type { ProcessBrowser, ProcessHarness } from "./process-harness.js";

export const PRE_RUNNER_SETTLED_ANSWERS_COMMIT =
	"312a926114d1b0feb54713208c3a7a380b4fc98e";

// Last main before draft attachments; its runner accepts and echoes string images.
export const PRE_DRAFT_ATTACHMENTS_COMMIT =
	"69961516dd68627b2e86c2f84e631cfc5f77aece";

export type HistoricalRunnerBundle =
	| {
			available: true;
			commit: string;
			dist: string;
			buildId: string;
			cacheDir: string;
			logPath: string;
	  }
	| { available: false; commit: string; reason: string; logPath?: string };

const builds = new Map<string, Promise<HistoricalRunnerBundle>>();

/** Select only the runner executable; the daemon still uses the current build. */
export function launchHistoricalRunners(
	harness: ProcessHarness,
	bundle: Extract<HistoricalRunnerBundle, { available: true }>,
): () => void {
	const gate = join(harness.root, "historical-runner-entry.json");
	writeFileSync(
		gate,
		JSON.stringify({
			entry: join(bundle.dist, "src/bin/claude-session-runner.js"),
		}),
	);
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`const historicalRunnerGate = ${JSON.stringify(gate)};
const originalRunnerSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (Array.isArray(args) && existsSync(historicalRunnerGate)) {
    const index = args.findIndex(arg => /claude-session-runner\\.(?:js|ts)$/.test(arg));
    if (index >= 0) {
      args = [...args];
      args[index] = JSON.parse(readFileSync(historicalRunnerGate, "utf8")).entry;
    }
  }
  return originalRunnerSpawn(command, args, options);
};
syncBuiltinESMExports();\n`,
	);
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`const historicalNet = await import("node:net");
const historicalAppend = (await import("node:fs")).appendFileSync;
const historicalWireProof = ${JSON.stringify(join(harness.root, "historical-runner-commands.ndjson"))};
const originalHistoricalSocketWrite = historicalNet.Socket.prototype.write;
historicalNet.Socket.prototype.write = function(chunk, ...args) {
  if (typeof chunk === "string" && chunk.includes('"type":"command"')) {
    for (const line of chunk.trim().split("\\n")) {
      try {
        const message = JSON.parse(line);
        if (message.type === "command") {
          historicalAppend(historicalWireProof, JSON.stringify({
            pid: process.pid,
            commandId: message.commandId,
            type: message.command.type,
            sinkId: message.command.sinkId,
            requestId: message.command.requestId,
          }) + "\\n");
        }
      } catch {}
    }
  }
  return originalHistoricalSocketWrite.call(this, chunk, ...args);
};\n`,
	);
	return () => rmSync(gate, { force: true });
}

/**
 * Send once while `launchHistoricalRunners` selects the pinned runner and prove the refusal:
 * runners from older builds are refused new work and their turns settled (CONTRACT.md
 * 3051-3054, 3069-3070). The send never reaches the SDK and its turn ends in an error.
 */
export async function expectHistoricalRefusal(
	harness: ProcessHarness,
	browser: ProcessBrowser,
	bundle: Extract<HistoricalRunnerBundle, { available: true }>,
	sessionId: string,
	prompt: string,
) {
	expect((await browser.send(sessionId, prompt)).chunks).toEqual([]);
	const entry = join(bundle.dist, "src/bin/claude-session-runner.js");
	expect(
		readdirSync(harness.root).filter(
			(name) =>
				name.startsWith("runner-argv-") &&
				(
					JSON.parse(readFileSync(join(harness.root, name), "utf8")) as string[]
				).includes(entry),
		),
	).not.toEqual([]);
	expect(harness.logTail).toMatch(/protocol mismatch/i);
	expect(
		harness.marks.filter(
			(mark) =>
				(mark.kind === "runner-started" && mark.buildId === bundle.buildId) ||
				(mark.kind === "enqueue" && mark.prompt === prompt),
		),
	).toEqual([]);
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		expect(
			db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
		).toEqual([{ status: "failed" }]);
		expect(
			db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted')",
				)
				.all(sessionId),
		).toEqual([{ type: "turn.error" }]);
	} finally {
		db.close();
	}
}

/** Build unchanged historical sources with their own dependency installation. */
export function historicalRunnerBundle(
	commit = PRE_RUNNER_SETTLED_ANSWERS_COMMIT,
	// Tests swap in a cheap build; callers keep the real one and the shared cache.
	{
		cacheRoot = join(tmpdir(), "conduit-historical-runner-bundles"),
		buildSource = buildCommit,
	}: {
		cacheRoot?: string;
		buildSource?: (
			commit: string,
			source: string,
			log: string,
		) => Promise<void>;
	} = {},
): Promise<HistoricalRunnerBundle> {
	const existing = builds.get(commit);
	if (existing) return existing;
	const building = build(commit, cacheRoot, buildSource);
	builds.set(commit, building);
	return building;
}

async function build(
	commit: string,
	cacheRoot: string,
	buildSource: (commit: string, source: string, log: string) => Promise<void>,
): Promise<HistoricalRunnerBundle> {
	if (!/^[a-f0-9]{40}$/.test(commit))
		throw new Error("Historical runner bundles require a full pinned commit");
	mkdirSync(cacheRoot, { recursive: true });
	const cacheName = `${commit}-${process.platform}-${process.arch}-${process.versions.modules}`;
	const cacheDir = join(cacheRoot, cacheName);
	const cached = cachedBundle(cacheDir, commit);
	if (cached) return cached;
	// One process builds a commit while vitest forks and other worktrees wait
	// for its bundle. The lock is a symlink naming its owner's pid, created
	// atomically, so a lock whose owner died is reclaimed.
	const lock = `${cacheDir}.lock`;
	for (;;) {
		try {
			symlinkSync(String(process.pid), lock);
			break;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
		}
		const owner = lockOwner(lock);
		if (owner === undefined) continue;
		// test-waits-allow real-wait: an owner's death leaves nothing on disk to observe.
		if (alive(owner)) await delay(1_000);
		else rmSync(lock, { force: true });
	}
	// The log sits beside the bundle so a failed build's survives its staging.
	const logPath = `${cacheDir}.log`;
	const stagingPrefix = `${cacheName}.staging-`;
	const staging = join(cacheRoot, `${stagingPrefix}${process.pid}`);
	try {
		const done = cachedBundle(cacheDir, commit);
		if (done) return done;
		// A build killed part way leaves its staging, named for its pid. The
		// lock holder's own pid can only name a dead process's leftover.
		for (const entry of readdirSync(cacheRoot)) {
			const pid = Number.parseInt(entry.slice(stagingPrefix.length), 10);
			if (
				entry.startsWith(stagingPrefix) &&
				(pid === process.pid || !alive(pid))
			)
				rmSync(join(cacheRoot, entry), { recursive: true, force: true });
		}
		mkdirSync(staging);
		writeFileSync(logPath, "");
		const source = join(staging, "source");
		await buildSource(commit, source, logPath);
		const { buildId } = JSON.parse(
			readFileSync(join(source, "dist/build-ready.json"), "utf8"),
		) as { buildId: string };
		writeFileSync(
			join(staging, "bundle.json"),
			JSON.stringify({ commit, buildId }),
		);
		// A bundle that lost files is not cached; replace it, or the rename
		// fails on every later build.
		if (!cachedBundle(cacheDir, commit)) {
			rmSync(cacheDir, { recursive: true, force: true });
			renameSync(staging, cacheDir);
		}
		const result = cachedBundle(cacheDir, commit);
		if (!result)
			throw new Error("Historical build did not emit a runner bundle");
		return result;
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			available: false,
			commit,
			logPath,
			reason: `Cannot produce historical runner ${commit}: ${reason}. Build log: ${logPath}`,
		};
	} finally {
		rmSync(staging, { recursive: true, force: true });
		// Reclaiming a dead owner's lock can race a new claim, so check it is ours.
		if (lockOwner(lock) === process.pid) rmSync(lock, { force: true });
	}
}

function lockOwner(lock: string): number | undefined {
	try {
		return Number(readlinkSync(lock));
	} catch {
		return undefined;
	}
}

/** EPERM still means a live process, owned by another user. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function buildCommit(
	commit: string,
	source: string,
	logPath: string,
): Promise<void> {
	// An isolated clone also works when the shared repository metadata is
	// read-only. Never install into this worktree's node_modules symlink.
	await command(
		"git",
		["clone", "--shared", "--no-checkout", "--quiet", resolve("."), source],
		dirname(source),
		logPath,
	);
	await command(
		"git",
		["checkout", "--detach", "--quiet", commit],
		source,
		logPath,
	);
	await command(
		"pnpm",
		["install", "--frozen-lockfile", "--prefer-offline"],
		source,
		logPath,
	);
	await command("pnpm", ["build"], source, logPath);
}

function cachedBundle(
	cacheDir: string,
	commit: string,
): Extract<HistoricalRunnerBundle, { available: true }> | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(join(cacheDir, "bundle.json"), "utf8"),
		) as { commit: string; buildId: string };
		const dist = join(cacheDir, "source/dist");
		if (
			manifest.commit !== commit ||
			typeof manifest.buildId !== "string" ||
			!existsSync(join(dist, "src/bin/claude-session-runner.js"))
		)
			return undefined;
		return {
			available: true,
			commit,
			dist,
			buildId: manifest.buildId,
			cacheDir,
			logPath: `${cacheDir}.log`,
		};
	} catch {
		return undefined;
	}
}

async function command(
	executable: string,
	args: string[],
	cwd: string,
	logPath: string,
): Promise<void> {
	const log = openSync(logPath, "a");
	try {
		await new Promise<void>((resolveCommand, reject) => {
			const child = spawn(executable, args, {
				cwd,
				env: { ...process.env, CI: "true" },
				detached: process.platform !== "win32",
				stdio: ["ignore", log, log],
			});
			const timeout = setTimeout(() => {
				if (child.pid === undefined) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code !== "ESRCH") reject(cause);
				}
			}, 180_000);
			child.once("error", (cause) => {
				clearTimeout(timeout);
				reject(cause);
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) resolveCommand();
				else
					reject(
						new Error(
							`${executable} ${args.join(" ")} exited ${signal ?? code}`,
						),
					);
			});
		});
	} finally {
		closeSync(log);
	}
}
