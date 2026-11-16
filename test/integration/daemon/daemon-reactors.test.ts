// Failure modes (lane 16l audit 45-47): the workspace hint must land for a project
// no tab has opened (registered while the daemon runs), in the project that owns
// the session when two projects share a folder, and never for a removed project.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	addWithoutRelay,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
import { bindEventStoreEffect } from "../../../src/lib/persistence/effect/bind-event-store-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeUnboundEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createDaemonProject } from "../../helpers/in-process-daemon.js";

const gitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"])
	delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});

const root = mkdtempSync(join(tmpdir(), "conduit-daemon-reactors-"));
const repo = join(root, "repo");
const worktree = join(root, "hinted");
let harness: Awaited<ReturnType<typeof createDaemonProject>>;
const artifact: Record<string, unknown> = {};

beforeAll(async () => {
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	writeFileSync(join(repo, "README.md"), "reactors\n");
	git(repo, "add", ".");
	git(
		repo,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-m",
		"init",
	);
	git(repo, "worktree", "add", "-b", "hinted", worktree);
	harness = await createDaemonProject("chat-simple", {
		projectDir: repo,
		slug: "reactors-opened",
		defaultModel: null,
	});
	// Registered while the daemon runs, on the opened project's folder; no tab opens them.
	await harness.daemon.runPromise(
		Effect.forEach(
			["reactors-unopened", "reactors-removed"],
			(slug) =>
				addWithoutRelay(
					{ slug, title: slug, folders: [repo] },
					{ silent: true },
				),
			{ discard: true },
		),
	);
});

afterAll(async () => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn-16-daemon-reactors.json",
		`${JSON.stringify(artifact, null, 2)}\n`,
	);
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** Commit into a project's store as its provider would, through the daemon's shared store. */
const commitTo = (projectId: string, events: Parameters<CommitEvents>[0]) =>
	harness.run(
		Effect.gen(function* () {
			const unbound = yield* makeUnboundEventStoreEffect;
			const commit = yield* makeCommitAndSignal.pipe(
				Effect.provideService(
					EventStoreEffectTag,
					bindEventStoreEffect(unbound, projectId),
				),
			);
			yield* commit(events);
		}),
	);
type CommitEvents = Effect.Success<typeof makeCommitAndSignal>;

const startSession = (projectId: string, sessionId: string) =>
	commitTo(projectId, [
		canonicalEvent(
			"session.created",
			sessionId,
			{ sessionId, title: sessionId, provider: "claude" },
			{ provider: "claude" },
		),
	]);

/** One turn of three writes in the linked worktree, then its end. */
const writeTurn = (projectId: string, sessionId: string) => {
	const messageId = randomUUID();
	const inputId = randomUUID();
	const runId = `run_${messageId}`;
	return commitTo(
		projectId,
		[
			canonicalEvent("run.requested", sessionId, { runId, inputId }),
			canonicalEvent("message.created", sessionId, {
				sessionId,
				messageId: inputId,
				role: "user",
			}),
			canonicalEvent("run.started", sessionId, {
				inputId,
				requestedRunId: runId,
			}),
			canonicalEvent("message.created", sessionId, {
				sessionId,
				messageId,
				parentID: inputId,
				role: "assistant",
			}),
			...[1, 2, 3].map((n) =>
				canonicalEvent("tool.started", sessionId, {
					messageId,
					partId: `write_${n}_${messageId}`,
					callId: `call_${n}_${messageId}`,
					toolName: "Write",
					input: {
						tool: "Write",
						filePath: join(worktree, `file-${n}.txt`),
						content: "x",
					},
				}),
			),
			canonicalEvent("turn.completed", sessionId, { messageId }),
		].map((event) => ({ ...event, provider: "claude", metadata: { runId } })),
	);
};

const hints = (sessionId: string) =>
	harness.run(
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql<{ project_id: string; path: string | null }>`
				SELECT project_id, json_extract(data, '$.path') AS path FROM events
				WHERE session_id = ${sessionId} AND type = 'session.workspace_hint_changed'
				ORDER BY sequence`,
		),
	);

/** Resolves once both sessions' hints are published on the daemon's session event bus. */
const hintsPublished = (sessionIds: readonly string[]) =>
	harness.daemon.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* (yield* SessionEventBusTag).subscribe();
				yield* events.pipe(
					Stream.filter(
						(event) =>
							event.type === "session.workspace_hint_changed" &&
							sessionIds.includes(event.sessionId),
					),
					Stream.take(sessionIds.length),
					Stream.runDrain,
					Effect.timeout("10 seconds"),
				);
			}),
		),
	);

it("hints a turn's worktree in the opened project, an unopened project sharing its folder, and never a removed one", async () => {
	const hinted = realpathSync(worktree);
	const opened = `opened-${randomUUID()}`;
	const unopened = `unopened-${randomUUID()}`;
	const removed = `removed-${randomUUID()}`;
	await startSession("reactors-opened", opened);
	await startSession("reactors-unopened", unopened);
	await startSession("reactors-removed", removed);
	await harness.daemon.runPromise(remove("reactors-removed"));

	const published = hintsPublished([opened, unopened]);
	await writeTurn("reactors-removed", removed);
	await writeTurn("reactors-unopened", unopened);
	await writeTurn("reactors-opened", opened);

	await published;
	const openedHints = await hints(opened);
	const unopenedHints = await hints(unopened);
	// The later turns' hints have landed, so the removed one had its chance too.
	const removedHints = await hints(removed);
	Object.assign(artifact, {
		worktree: hinted,
		opened: openedHints,
		unopened: unopenedHints,
		removed: removedHints,
	});
	expect(openedHints).toEqual([
		{ project_id: "reactors-opened", path: hinted },
	]);
	expect(unopenedHints).toEqual([
		{ project_id: "reactors-unopened", path: hinted },
	]);
	expect(removedHints).toEqual([]);
});
