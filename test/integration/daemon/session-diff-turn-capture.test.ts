import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Fiber, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffListing } from "../../../src/lib/contracts/session-diff.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure modes of a turn diff whose run-end capture is late or fails (the
// numbers are the lane audit's): 1 a capture that lands after the browser
// asked reads Not captured, and the live view never learns it landed; 2 a
// capture that fails after pending was shown stays pending, or reads Not
// captured with no reason; 3 a daemon restart mid-capture leaves the turn
// pending forever, reads Not captured, or lists files written after its run
// ended (lane f02e9.20); 4 a packaging failure records nothing, or the next turn's
// capture chains onto it or lists its files; 5 a capture queued behind an
// earlier turn's reads Not captured or lands with the earlier files; 6 a
// browser that reconnects while pending never follows the landing; 7 the
// pending and Not captured listings share a revision. Holding the session
// store's ref lock holds a capture at packaging, as a slow disk would.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of GIT_KEYS) delete gitEnv[key];

const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/** Resolves once `done` holds, checked on each change in `directory`; the test's timeout bounds it. */
const changed = (directory: string, done: () => boolean) =>
	new Promise<void>((resolve) => {
		const check = () => {
			if (!done()) return;
			watcher.close();
			resolve();
		};
		const watcher = watch(directory, check).on("error", () => watcher.close());
		check();
	});

/** A listing as the turn footer reads it. */
const shape = (listing: SessionDiffListing) => ({
	...(listing.pending ? { pending: true } : {}),
	...(listing.notCaptured ? { notCaptured: true } : {}),
	folders: listing.folders.map((folder) =>
		"files" in folder
			? folder.files.map(({ path, status }) => [path, status])
			: folder.error,
	),
});

describe("Turn diff capture states through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidenceFile = "";
	const evidence: Record<string, unknown> = {};
	const feeds: Fiber.Fiber<void, unknown>[] = [];

	afterEach(async ({ task }) => {
		await Promise.all(
			feeds.splice(0).map((feed) => Effect.runPromise(Fiber.interrupt(feed))),
		);
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		try {
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				evidenceFile,
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			for (const key of Object.keys(evidence)) delete evidence[key];
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	/** A daemon with one git project folder and a session that edits it once per turn. */
	async function start(turns: number) {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		const fixture = ProcessHarness.create({
			claudeReplay: {
				turns: Array.from({ length: turns }, () => "pong-thinking-text-turn"),
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		harness = fixture;
		const repo = fixture.projectDir;
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "base.txt"), "base\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Capture test",
			"-c",
			"user.email=capture@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"-m",
			"Initial commit",
		);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [repo],
		});
		const browser = await fixture.connect();
		const session = await browser.createSession("Captures");
		const release = join(fixture.root, "claude-replay-release");
		const store = join(
			fixture.configDir,
			"folder-timeline",
			"sessions",
			`${createHash("sha256").update(session).digest("hex").slice(0, 16)}.git`,
		);
		const query = <Row>(statement: string, ...params: string[]) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db.prepare(statement).all(...params) as Row[];
			} finally {
				db.close();
			}
		};
		return {
			fixture,
			repo,
			browser,
			session,
			store,
			/** The session store's ref lock: while it exists, a capture cannot finish packaging. */
			lock: join(store, "refs", "conduit", "session.lock"),
			/** Runs one turn that writes `path` while its run is open; answers its turn id. */
			turn: async (path: string) => {
				rmSync(release, { force: true });
				const assistant = (message: Record<string, unknown>) =>
					message["type"] === "transcript_message" &&
					message["sessionId"] === session &&
					message["role"] === "assistant";
				// An earlier turn's message can still update after its send returns.
				const earlier = new Set(
					browser.frames
						.map(({ message }) => message)
						.filter(assistant)
						.map((message) => message["id"]),
				);
				const cursor = browser.frames.length;
				const sending = browser.send(session, `Write ${path}.`);
				void sending.catch(() => {});
				// The new turn's reply follows its start checkpoint, which runs before the provider.
				await browser.waitFor(
					(message) => assistant(message) && !earlier.has(message["id"]),
					cursor,
				);
				writeFileSync(join(repo, path), `${path}\n`);
				writeFileSync(release, "release\n");
				await sending;
				return (
					query<{ id: string }>(
						"SELECT id FROM turns WHERE session_id = ? ORDER BY requested_at",
						session,
					).at(-1)?.id ?? ""
				);
			},
			list: (turnId: string, revision?: string) =>
				sendRpcRequest(socket, {
					_tag: "SessionDiffList",
					sessionId: session,
					scope: { kind: "turn", turnId },
					...(revision === undefined ? {} : { revision }),
				}),
			/** Follows a browser's live turn scope; answers the next revision it pushes. */
			follow: (viewer: ProcessBrowser, turnId: string) => {
				const pushed = Effect.runSync(Queue.unbounded<string>());
				feeds.push(
					Effect.runFork(
						Stream.runForEach(
							viewer.rpc.SubscribeSessionDiff({
								sessionId: session,
								scope: { kind: "turn", turnId },
							}),
							({ revision }) => Queue.offer(pushed, revision),
						),
					),
				);
				return {
					next: () => Effect.runPromise(Queue.take(pushed)),
					waiting: () => Effect.runSync(Queue.size(pushed)),
				};
			},
			runOf: (turnId: string) =>
				query<{ run_id: string }>(
					"SELECT run_id FROM turns WHERE id = ?",
					turnId,
				)[0]?.run_id,
			capturedEvents: () =>
				query<{ data: string }>(
					"SELECT data FROM events WHERE session_id = ? AND type = 'run.changes_captured' ORDER BY sequence",
					session,
				).map(({ data }) => JSON.parse(data) as { runId: string }),
		};
	}

	it("shows a slow capture as pending, then its diff or its gap, to every browser that follows it", async () => {
		evidenceFile = "test-results/f02e9-17-pending.json";
		const { fixture, repo, browser, store, lock, turn, list, follow } =
			await start(3);
		const first = await turn("first.txt");
		expect(shape(await list(first))).toEqual({
			folders: [[["first.txt", "added"]]],
		});

		// The first capture made the session's store. Waiting on its ref lock
		// with no retry limit, a capture is held until git's own deadline.
		git(store, "config", "core.filesRefLockTimeout", "-1");
		writeFileSync(lock, "");
		const second = await turn("second.txt");
		// Ends while the second capture is held, so its capture queues behind it.
		const third = await turn("third.txt");
		const secondFeed = follow(browser, second);
		const thirdFeed = follow(browser, third);
		const reconnected = await fixture.connect();
		const thirdAgain = follow(reconnected, third);
		const [secondPending, thirdPending] = await Promise.all([
			list(second),
			list(third),
		]);
		evidence["secondPending"] = secondPending;
		evidence["thirdPending"] = thirdPending;
		expect(shape(secondPending)).toEqual({ pending: true, folders: [] });
		expect(shape(thirdPending)).toEqual({ pending: true, folders: [] });
		expect(
			await Promise.all([
				secondFeed.next(),
				thirdFeed.next(),
				thirdAgain.next(),
			]),
		).toEqual([
			secondPending.revision,
			thirdPending.revision,
			thirdPending.revision,
		]);

		// Git's deadline ends the held packaging: the second turn reads its gap.
		const secondLanded = await list(second, await secondFeed.next());
		evidence["secondLanded"] = secondLanded;
		expect(shape(secondLanded)).toEqual({ folders: ["timeout"] });
		expect(secondLanded.revision).not.toBe(secondPending.revision);
		expect(thirdFeed.waiting()).toBe(0);

		// The third capture packages once the lock goes, with only its own file.
		rmSync(lock);
		const thirdRevision = await thirdFeed.next();
		expect(await thirdAgain.next()).toBe(thirdRevision);
		const thirdLanded = await list(third, thirdRevision);
		evidence["thirdLanded"] = thirdLanded;
		expect(shape(thirdLanded)).toEqual({
			folders: [[["third.txt", "added"]]],
		});
		expect(thirdLanded.folders[0]?.folder).toBe(repo);
	});

	it("finishes the captures a daemon restart interrupted, with each turn's own files", async () => {
		evidenceFile = "test-results/f02e9-20-restart.json";
		const {
			fixture,
			repo,
			store,
			lock,
			turn,
			list,
			follow,
			runOf,
			capturedEvents,
		} = await start(3);
		const first = await turn("first.txt");
		expect(shape(await list(first))).toEqual({
			folders: [[["first.txt", "added"]]],
		});
		git(store, "config", "core.filesRefLockTimeout", "-1");
		writeFileSync(lock, "");
		// Held at the session ref: packed, not yet chained.
		const second = await turn("second.txt");
		// Queued behind the second capture, with its end checkpoint taken.
		const third = await turn("third.txt");
		const pending = await list(third);
		evidence["pending"] = pending;
		expect(shape(pending)).toEqual({ pending: true, folders: [] });
		const timeline = join(fixture.configDir, "folder-timeline");
		const repoStore = join(
			timeline,
			readdirSync(timeline).find((name) => name.endsWith(".git")) ?? "",
		);
		const thirdPins = `refs/conduit/runs/${runOf(third)}/`;
		await changed(join(repoStore, thirdPins), () =>
			git(
				repoStore,
				"for-each-ref",
				"--format=%(contents:subject)",
				thirdPins,
			).includes('"end"'),
		);

		// The daemon dies mid-capture. Its held git outlives it and chains the
		// second capture once the lock goes.
		await fixture.kill();
		rmSync(lock);
		await changed(
			join(store, "refs", "conduit"),
			() => git(store, "rev-list", "--count", "refs/conduit/session") === "2",
		);
		// The user edits while the daemon is down.
		writeFileSync(join(repo, "after-crash.txt"), "after\n");
		await fixture.restart();

		const viewer = await fixture.connect();
		const landed = await Promise.all(
			[second, third].map(async (turnId) => {
				const feed = follow(viewer, turnId);
				for (;;) {
					const listing = await list(turnId, await feed.next());
					if (!listing.pending) return listing;
				}
			}),
		);
		evidence["secondLanded"] = landed[0];
		evidence["thirdLanded"] = landed[1];
		expect(landed.map(shape)).toEqual([
			{ folders: [[["second.txt", "added"]]] },
			{ folders: [[["third.txt", "added"]]] },
		]);
		const runs = capturedEvents().map((event) => event.runId);
		evidence["capturedRuns"] = runs;
		// Recovered captures queue on the session's store in no set order.
		expect([...runs].sort()).toEqual(
			[runOf(first), runOf(second), runOf(third)].sort(),
		);
		evidence["chainLength"] = git(
			store,
			"rev-list",
			"--count",
			"refs/conduit/session",
		);
		evidence["pinsAfter"] = git(
			repoStore,
			"for-each-ref",
			"--format=%(refname)",
			"refs/conduit/runs/",
		);
		expect(evidence["pinsAfter"]).toBe("");
	});

	it("records a gap when packaging a capture fails, and the next turn captures on its own", async () => {
		evidenceFile = "test-results/f02e9-17-packaging-gap.json";
		const { store, lock, turn, list, capturedEvents } = await start(3);
		const first = await turn("first.txt");
		const firstListing = await list(first);
		expect(shape(firstListing)).toEqual({
			folders: [[["first.txt", "added"]]],
		});
		// Git's default ref lock retry is short, so packaging fails at once.
		writeFileSync(lock, "");
		const second = await turn("second.txt");
		const failed = await list(second);
		evidence["failed"] = failed;
		expect(shape(failed)).toEqual({ folders: ["unavailable"] });
		const [failedFolder] = failed.folders;
		expect(
			failedFolder && "message" in failedFolder && failedFolder.message,
		).toContain("session.lock");
		rmSync(lock);

		const third = await turn("third.txt");
		const next = await list(third);
		evidence["next"] = next;
		expect(shape(next)).toEqual({ folders: [[["third.txt", "added"]]] });
		expect(await list(first)).toEqual(firstListing);
		const events = capturedEvents();
		evidence["capturedEvents"] = events;
		expect(events).toHaveLength(3);
		expect(events[1]).toMatchObject({ folders: [{ gap: "failed" }] });
		// The failed capture never joined the session's chain.
		evidence["chainLength"] = git(
			store,
			"rev-list",
			"--count",
			"refs/conduit/session",
		);
		expect(evidence["chainLength"]).toBe("2");
	});
});
