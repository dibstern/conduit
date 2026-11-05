/*
 * 82tn.11 acceptance: approvals and questions across projects.
 * Failure catalogue entries covered: 1-11 (lane audit).
 * A Claude session in project A asks for approval and another asks a
 * question while the client views project B. B's daemon shell shows each as
 * waiting on you; Open moves the client to the asking session, as the
 * browser's toast does; one answer reaches the provider and the turn ends.
 * The same holds after a browser reconnect and after a daemon restart.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "-b", "main", directory],
		[
			"-C",
			directory,
			"-c",
			"user.name=Cross-project asks test",
			"-c",
			"user.email=asks@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
	])
		execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
}

const startup = { startupTimeoutMs: 120_000, runnerStartupTimeoutMs: 90_000 };

/** What the provider was told: one mark per answer it received. */
function providerAnswers(fixture: ProcessHarness, prompt: string) {
	const path = join(fixture.root, "sdk-proof.ndjson");
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(mark) =>
				mark["prompt"] === prompt &&
				(mark["kind"] === "approval" || mark["kind"] === "prompt-answer"),
		);
}

function askEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type IN ('permission.asked', 'permission.resolved', 'question.asked', 'question.resolved') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string }>
		).map((row) => row.type);
	} finally {
		db.close();
	}
}

type NeedsYou = "approval" | "reply";

/** B's daemon shell row says the session waits on you, and for what. */
const waitingOnYou = (
	browser: ProcessBrowser,
	sessionId: string,
	needsYou: NeedsYou,
	cursor = 0,
) =>
	browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			(message["activity"] as { needsYou?: string } | undefined)?.needsYou ===
				needsYou &&
			Number(
				message[
					needsYou === "approval"
						? "pendingPermissionCount"
						: "pendingQuestionCount"
				] ?? 0,
			) === 1,
		cursor,
		60_000,
	);

const noLongerWaiting = (
	browser: ProcessBrowser,
	sessionId: string,
	cursor: number,
) =>
	browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			(message["activity"] as { needsYou?: string } | undefined)?.needsYou ===
				undefined &&
			message["pendingPermissionCount"] === undefined &&
			message["pendingQuestionCount"] === undefined,
		cursor,
		60_000,
	);

const card = (browser: ProcessBrowser, sessionId: string, cursor: number) =>
	browser.waitFor(
		(message) =>
			(message["type"] === "permission_pending" ||
				message["type"] === "question_pending") &&
			message["sessionId"] === sessionId,
		cursor,
		60_000,
	);

describe("approvals and questions across projects (82tn.11)", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const logs = fixture.logTail;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-11-${evidence["scenario"]}.json`,
				JSON.stringify(
					{
						bead: "conduit-test-82tn.11",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						...(task.result?.errors?.length ? { logs } : {}),
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	/** Projects A and B, two asking sessions in A and one session in B. */
	async function twoProjects(scenario: string) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { scenario };
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
			logLevel: "info",
		});
		harness = fixture;
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart(startup);
		const { savedSlug: slugB } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const create = async (projectSlug: string, title: string) =>
			(
				await fixture.requestRpc({
					_tag: "CreateSession",
					projectSlug,
					originId: "cross-project-asks",
					providerId: "claude",
					model: { providerId: "claude", modelId: "sonnet" },
					permissionMode: "ask",
					title,
				})
			).sessionId;
		const sessions = {
			approval: await create("process-test", "Approval in A"),
			question: await create("process-test", "Question in A"),
			b: await create(slugB, "Viewed in B"),
		};
		return { fixture, slugB, sessions };
	}

	/** Project A's client raises the asks, then leaves: only B watches. */
	async function raiseInA(
		fixture: ProcessHarness,
		asks: ReadonlyArray<readonly [sessionId: string, prompt: string]>,
	) {
		const [[first] = []] = asks;
		const starter = await fixture.connect(first, undefined, "process-test");
		for (const [sessionId, prompt] of asks)
			void starter.send(sessionId, prompt, 120_000).catch(() => undefined);
		for (const [sessionId] of asks) await card(starter, sessionId, 0);
		await starter.close();
	}

	const both = (
		sessions: { approval: string; question: string },
		prompts: { approval: string; question: string },
	) =>
		[
			[sessions.approval, prompts.approval],
			[sessions.question, prompts.question],
		] as const;

	const settle = (answer: Promise<void>) =>
		answer.then(
			() => "accepted",
			(error: unknown) => `refused: ${String(error)}`,
		);

	/** Open each asking session from B, answer once, and see its turn end. */
	async function answerFromB(
		viewer: ProcessBrowser,
		fixture: ProcessHarness,
		sessions: { approval: string; question: string },
		prompts: { approval: string; question: string },
	) {
		const repeated: Record<string, string> = {};
		for (const kind of ["approval", "question"] as const) {
			const sessionId = sessions[kind];
			const cursor = viewer.frames.length;
			await viewer.open(sessionId);
			// From the first frame: when the feed is already on A, the card came
			// before Open.
			const ask = await card(viewer, sessionId, 0);
			const answer = () =>
				kind === "approval"
					? viewer.answerApproval(ask, "allow")
					: viewer.answerQuestion(ask, { "0": "Continue" });
			await answer();
			// A second answer to the same ask never reaches the provider.
			repeated[kind] = await settle(answer());
			await viewer.waitForTurnEnd(sessionId, cursor, 60_000);
			await noLongerWaiting(viewer, sessionId, cursor);
			expect(
				providerAnswers(fixture, prompts[kind]),
				`${kind} reached the provider once`,
			).toHaveLength(1);
		}
		return repeated;
	}

	it("shows A's approval and question in B, answered once after Open", async () => {
		const { fixture, slugB, sessions } = await twoProjects("answered-from-b");
		const prompts = {
			approval: "approval-cross-project",
			question: "question-fixed-cross-project",
		};
		const viewer = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, both(sessions, prompts));

		await waitingOnYou(viewer, sessions.approval, "approval");
		await waitingOnYou(viewer, sessions.question, "reply");
		const repeated = await answerFromB(viewer, fixture, sessions, prompts);

		evidence = {
			...evidence,
			sessions,
			repeatedAnswer: repeated,
			provider: {
				approval: providerAnswers(fixture, prompts.approval),
				question: providerAnswers(fixture, prompts.question),
			},
			events: {
				approval: askEvents(fixture, sessions.approval),
				question: askEvents(fixture, sessions.question),
			},
		};
		expect(askEvents(fixture, sessions.approval)).toEqual([
			"permission.asked",
			"permission.resolved",
		]);
		expect(askEvents(fixture, sessions.question)).toEqual([
			"question.asked",
			"question.resolved",
		]);
	});

	it("shows A's asks to a reconnected B client, which answers them", async () => {
		const { fixture, slugB, sessions } = await twoProjects("reconnect");
		const prompts = {
			approval: "approval-cross-reconnect",
			question: "question-fixed-cross-reconnect",
		};
		const before = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, both(sessions, prompts));
		await waitingOnYou(before, sessions.approval, "approval");
		await before.close();

		const after = await fixture.connect(sessions.b, undefined, slugB);
		await waitingOnYou(after, sessions.approval, "approval");
		await waitingOnYou(after, sessions.question, "reply");
		const repeated = await answerFromB(after, fixture, sessions, prompts);
		evidence = {
			...evidence,
			sessions,
			repeatedAnswer: repeated,
			events: {
				approval: askEvents(fixture, sessions.approval),
				question: askEvents(fixture, sessions.question),
			},
		};
	});

	it("shows A's asks in B after a daemon restart, answered once", async () => {
		const { fixture, slugB, sessions } = await twoProjects("daemon-restart");
		const prompts = {
			approval: "approval-cross-restart",
			question: "question-fixed-cross-restart",
		};
		const before = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, both(sessions, prompts));
		await waitingOnYou(before, sessions.approval, "approval");
		await waitingOnYou(before, sessions.question, "reply");
		await before.close();
		await fixture.kill();
		await fixture.restart(startup);

		const after = await fixture.connect(sessions.b, undefined, slugB);
		await waitingOnYou(after, sessions.approval, "approval");
		await waitingOnYou(after, sessions.question, "reply");
		const repeated = await answerFromB(after, fixture, sessions, prompts);
		evidence = {
			...evidence,
			sessions,
			repeatedAnswer: repeated,
			events: {
				approval: askEvents(fixture, sessions.approval),
				question: askEvents(fixture, sessions.question),
			},
		};
		expect(askEvents(fixture, sessions.approval)).toEqual([
			"permission.asked",
			"permission.resolved",
		]);
		expect(askEvents(fixture, sessions.question)).toEqual([
			"question.asked",
			"question.resolved",
		]);
	});

	it("lets one of two answers given in A and B at once reach the provider", async () => {
		const { fixture, slugB, sessions } = await twoProjects(
			"answered-in-a-and-b",
		);
		const prompt = "approval-cross-race";
		const viewer = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, [[sessions.approval, prompt]]);
		await waitingOnYou(viewer, sessions.approval, "approval");
		const inA = await fixture.connect(
			sessions.approval,
			undefined,
			"process-test",
		);
		const cursor = viewer.frames.length;
		await viewer.open(sessions.approval);
		const [askA, askB] = await Promise.all([
			card(inA, sessions.approval, 0),
			card(viewer, sessions.approval, 0),
		]);
		const outcomes = await Promise.all([
			settle(inA.answerApproval(askA, "allow")),
			settle(viewer.answerApproval(askB, "deny")),
		]);
		await viewer.waitForTurnEnd(sessions.approval, cursor, 60_000);
		await noLongerWaiting(viewer, sessions.approval, cursor);
		const delivered = providerAnswers(fixture, prompt);
		evidence = {
			...evidence,
			sessions,
			outcomes: { a: outcomes[0], b: outcomes[1] },
			provider: delivered,
			events: askEvents(fixture, sessions.approval),
		};
		expect(delivered, "one answer reached the provider").toHaveLength(1);
		expect(askEvents(fixture, sessions.approval)).toEqual([
			"permission.asked",
			"permission.resolved",
		]);
	});

	it("clears A's ask in B when its run is cancelled, and a late answer delivers nothing", async () => {
		const { fixture, slugB, sessions } = await twoProjects("run-ended");
		const prompt = "approval-cross-cancelled";
		const viewer = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, [[sessions.approval, prompt]]);
		await waitingOnYou(viewer, sessions.approval, "approval");
		const cursor = viewer.frames.length;
		await viewer.open(sessions.approval);
		const ask = await card(viewer, sessions.approval, 0);
		await Effect.runPromise(
			viewer.rpc.CancelSession({
				sessionId: sessions.approval,
				commandId: randomUUID(),
			}),
		);
		await noLongerWaiting(viewer, sessions.approval, cursor);
		const late = await settle(viewer.answerApproval(ask, "allow"));
		const delivered = providerAnswers(fixture, prompt);
		evidence = {
			...evidence,
			sessions,
			lateAnswer: late,
			provider: delivered,
			events: askEvents(fixture, sessions.approval),
		};
		expect(
			delivered.filter((mark) => mark["behavior"] === "allow"),
			"the late allow never reached the provider",
		).toEqual([]);
		expect(askEvents(fixture, sessions.approval)).toEqual([
			"permission.asked",
			"permission.resolved",
		]);
	});

	it("removes A's ask from B when its session is deleted, and a late answer delivers nothing", async () => {
		const { fixture, slugB, sessions } = await twoProjects("session-deleted");
		const prompt = "approval-cross-deleted";
		const viewer = await fixture.connect(sessions.b, undefined, slugB);
		await raiseInA(fixture, [[sessions.approval, prompt]]);
		await waitingOnYou(viewer, sessions.approval, "approval");
		const cursor = viewer.frames.length;
		await viewer.open(sessions.approval);
		const ask = await card(viewer, sessions.approval, 0);
		await viewer.deleteSession(sessions.approval);
		await viewer.waitFor(
			(message) =>
				message["type"] === "session_removed" &&
				message["id"] === sessions.approval,
			cursor,
			60_000,
		);
		await viewer.waitFor(
			(message) =>
				message["type"] === "approval_removed" &&
				message["id"] === ask["requestId"],
			cursor,
			60_000,
		);
		const late = await settle(viewer.answerApproval(ask, "allow"));
		const delivered = providerAnswers(fixture, prompt);
		evidence = {
			...evidence,
			sessions,
			lateAnswer: late,
			provider: delivered,
		};
		expect(
			delivered.filter((mark) => mark["behavior"] === "allow"),
			"the late allow never reached the provider",
		).toEqual([]);
	});
});
