import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
	createReplayHarness,
	type ReplayHarness,
} from "../../e2e/helpers/e2e-harness.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

// Native fork copies arrive before the fork HTTP response. They are history,
// not native acceptance of new work in the fork.
let harness: DaemonProject | undefined;
let replayHarness: ReplayHarness | undefined;
let replayClient: TestWsClient | undefined;
afterEach(async () => {
	await replayClient?.close();
	await replayHarness?.stop();
	replayClient = undefined;
	replayHarness = undefined;
	await harness?.stop();
	harness = undefined;
});

it("recorded native fork copies never keep the first fresh input queued", async () => {
	harness = await createDaemonProject("fork-session");
	const client = await harness.connectWsClient();
	await client.waitForInitialState();
	const created = await client.createSession("Fork source", {
		providerId: "opencode",
	});
	const parentId = String(created["id"]);
	for (const prompt of [
		"Remember the word 'alpha'. Reply with only: ok, remembered.",
		"Now remember 'beta' too. Reply with only: ok, remembered.",
	]) {
		await client.sendMessage(prompt, { sessionId: parentId });
		await client.waitForTurnEnd(parentId, 15_000);
	}
	const fork = await client.forkSession({ sessionId: parentId });
	const forkId = String(fork["id"]);
	const db = new Database(harness.eventsDbPath, { readonly: true });
	try {
		await vi.waitFor(
			() => {
				expect(
					db
						.prepare(
							"SELECT count(*) AS count FROM messages WHERE session_id = ?",
						)
						.get(forkId),
				).toEqual({ count: 4 });
			},
			{ timeout: 10_000 },
		);
		expect(
			db
				.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
				.all(forkId),
		).toEqual([]);
		const prompt =
			"What words did I ask you to remember? Reply with just the words.";
		await client.sendMessage(prompt, {
			sessionId: forkId,
			commandId: "fresh-fork-input",
		});
		await vi.waitFor(
			() => {
				expect(
					db
						.prepare(
							"SELECT text, is_inherited FROM messages WHERE session_id = ? AND input_id = ?",
						)
						.get(forkId, "fresh-fork-input"),
				).toEqual({ text: prompt, is_inherited: 0 });
			},
			{ timeout: 10_000 },
		);
		await client.waitForTurnEnd(forkId, 15_000);
		expect(
			db
				.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
				.all(forkId),
		).toEqual([{ status: "completed" }]);
		expect(
			db
				.prepare(
					"SELECT turns.state FROM turns JOIN messages ON messages.id = turns.id WHERE turns.session_id = ? AND messages.input_id = ?",
				)
				.get(forkId, "fresh-fork-input"),
		).toEqual({ state: "completed" });
	} finally {
		db.close();
	}
}, 60_000);

it("a recorded OpenCode 1.19 fork binds the fork OpenCode named and holds its copies once", async () => {
	// Recorded by test/e2e/provider/opencode-fork-wire-capture.test.ts (82tn.81).
	const recorded = loadOpenCodeRecording("opencode-native-fork");
	const nativeFork = recorded.interactions.flatMap((i) =>
		i.kind === "rest" && /\/fork$/.test(i.path.split("?")[0] ?? "")
			? [(i.responseBody as { id: string }).id]
			: [],
	);
	harness = await createDaemonProject("opencode-native-fork");
	const client = await harness.connectWsClient();
	await client.waitForInitialState();
	// The project opens on the session the recording created.
	const parentId = client.getActiveSessionId();
	if (!parentId) throw new Error("No session to fork");
	for (const prompt of ["Remember fork-one.", "Remember fork-two."]) {
		await client.sendMessage(prompt, { sessionId: parentId });
		await client.waitForTurnEnd(parentId, 15_000);
	}
	const db = new Database(harness.eventsDbPath, { readonly: true });
	const transcript = (sessionId: string) =>
		db
			.prepare(
				"SELECT role, text FROM messages WHERE session_id = ? ORDER BY rowid",
			)
			.all(sessionId)
			.map((row) => {
				const { role, text } = row as { role: string; text: string };
				return `${role}: ${text}`;
			});
	let forkId = "";
	try {
		const kept = db
			.prepare(
				"SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY rowid LIMIT 1",
			)
			.get(parentId) as { id: string };
		// The replay's user rows carry Conduit's ids and the recording's, so pin the
		// source's rows rather than their text: the fork must leave them alone.
		const parentBefore = transcript(parentId);
		forkId = String(
			(await client.forkSession({ sessionId: parentId, messageId: kept.id }))[
				"id"
			],
		);
		expect([forkId]).toEqual(nativeFork);
		await client.sendMessage("Now fork-three.", { sessionId: forkId });
		await client.waitForTurnEnd(forkId, 15_000);
		await client.waitForTranscriptMessage(
			(message) =>
				message.role === "assistant" &&
				(message.parts ?? []).some(
					(part) => part.type === "text" && part.text === "Heard fork-three.",
				),
			forkId,
		);
		expect(transcript(forkId)).toEqual([
			"user: Remember fork-one.",
			"assistant: Heard fork-one.",
			"user: Now fork-three.",
			"assistant: Heard fork-three.",
		]);
		expect(transcript(parentId)).toEqual(parentBefore);
		expect(
			db
				.prepare("SELECT id FROM sessions")
				.all()
				.map((row) => (row as { id: string }).id)
				.sort(),
		).toEqual([parentId, forkId].sort());
	} finally {
		const dir = process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "opencode-native-fork-replay.json"),
			JSON.stringify(
				{
					opencodeVersion: recorded.opencodeVersion,
					parentId,
					forkId,
					sessions: db
						.prepare(
							"SELECT id, provider_sid, fork_point_event FROM sessions ORDER BY id",
						)
						.all(),
					parent: transcript(parentId),
					fork: forkId ? transcript(forkId) : [],
				},
				null,
				2,
			),
		);
		db.close();
	}
});

it.each([
	{
		recording: "side-thread-status",
		prompt: "What word did I ask you to remember? Reply with only the word.",
		approval: undefined,
	},
	{
		recording: "side-thread-permission",
		prompt:
			"Use the bash tool to run printf 'side-thread-approval'. Do not answer without running this command.",
		approval: "permission",
	},
	{
		recording: "side-thread-question",
		prompt:
			"Use the question tool to ask me to choose between Alpha and Beta, with header Choice and question Which word should we use? Wait for my answer before continuing.",
		approval: "question",
	},
])("a recorded $recording sends its first input after inherited history", async ({
	recording,
	prompt,
	approval,
}) => {
	const replay = await createReplayHarness(recording);
	replayHarness = replay;
	const parentId = replay.projectUrl.split("/").at(-1);
	if (!parentId) throw new Error("Replay source is missing");
	const client = new TestWsClient(
		`ws://127.0.0.1:${replay.appPort}/rpc?p=e2e-replay`,
		parentId,
	);
	replayClient = client;
	await client.waitForOpen();
	await client.waitForInitialState();
	await client.sendMessage(
		"Remember the word 'alpha'. Reply with only: ok, remembered.",
		{ sessionId: parentId },
	);
	await client.waitForTurnEnd(parentId, 15_000);
	const release = approval
		? replay.mock.holdNextPrompt(
				approval === "permission" ? "permission.asked" : "question.asked",
			)
		: () => {};
	const side = await client.rpcCall((rpc) =>
		rpc.StartSideThread({
			sessionId: parentId,
			title: "Question",
			inputId: "side-input",
			text: prompt,
			originId: client.getClientId(),
		}),
	);
	const sideId = side.sessionId;
	expect(sideId).not.toBe(parentId);
	await client.viewSession(sideId);
	const db = new Database(replay.eventsDbPath, { readonly: true });
	try {
		await vi.waitFor(
			() => {
				expect(
					db
						.prepare(
							"SELECT text, is_inherited FROM messages WHERE session_id = ? AND input_id = ?",
						)
						.get(sideId, "side-input"),
				).toEqual({
					text: prompt,
					is_inherited: 0,
				});
			},
			{ timeout: 10_000 },
		);
		if (approval) {
			await vi.waitFor(
				() => {
					expect(
						db
							.prepare(
								"SELECT type, status FROM pending_approvals WHERE session_id = ?",
							)
							.all(sideId),
					).toEqual([{ type: approval, status: "pending" }]);
				},
				{ timeout: 10_000 },
			);
		} else {
			await client.waitForTurnEnd(sideId, 15_000);
		}
		expect(
			db
				.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
				.all(sideId),
		).toEqual([{ status: approval ? "running" : "completed" }]);
		expect(
			db.prepare("SELECT status FROM sessions WHERE id = ?").get(parentId),
		).toEqual({ status: "idle" });
		expect(
			db
				.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
				.all(parentId),
		).toEqual([{ status: "completed" }]);
		if (approval) {
			release();
			await vi.waitFor(
				() => {
					expect(
						db
							.prepare(
								"SELECT status FROM pending_approvals WHERE session_id = ?",
							)
							.all(sideId),
					).toEqual([{ status: "resolved" }]);
				},
				{ timeout: 10_000 },
			);
		}
	} finally {
		release();
		const dir = process.env["CONDUIT_TEST_ARTIFACT_DIR"];
		if (dir) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `${recording}-fork-facts.json`),
				JSON.stringify(
					{
						sessions: db
							.prepare(
								"SELECT id, fork_point_event, fork_point_timestamp, status FROM sessions",
							)
							.all(),
						runs: db.prepare("SELECT * FROM provider_runs").all(),
						events: db
							.prepare(
								"SELECT sequence, session_id, type, data, metadata FROM events WHERE session_id = ?",
							)
							.all(sideId),
					},
					null,
					2,
				),
			);
		}
		db.close();
	}
}, 60_000);
