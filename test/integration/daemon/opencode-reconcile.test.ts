import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: prompts asked while the stream was down are lost, one
// project's prompt leaks into another, a reconnect re-delivers a prompt once
// per subscriber, a relay joining a live stream misses state, and a dropped
// idle event leaves a session busy forever, or recovered prompts duplicate
// canonical events across reconnects and daemon restarts.
describe("OpenCode Instances recovery and reconciliation", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "reconnect";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.4", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		await harness.restart();
		return harness;
	}

	async function addProject(fixture: ProcessHarness, directory: string) {
		mkdirSync(directory, { recursive: true });
		const result = await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
			_tag: "SaveProject",
			folders: [directory],
		});
		return result.savedSlug;
	}

	// Ask cards reach every tab, whatever project it shows (82tn.13), so a card
	// shows its routing by the session it names and that session's project.
	function cards(fixture: ProcessHarness, browser: ProcessBrowser, id: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return browser.frames
				.filter(
					({ message }) =>
						message["type"] === "permission_pending" &&
						message["requestId"] === fixture.promptIdForProviderRequest(id),
				)
				.map(({ message }) => {
					const sessionId = String(message["sessionId"]);
					const row = db
						.prepare("SELECT project_id FROM sessions WHERE id = ?")
						.get(sessionId) as { project_id: string } | undefined;
					return { project: row?.project_id, sessionId };
				});
		} finally {
			db.close();
		}
	}

	// Another project's session reaches a tab only as its ask card; any other
	// frame naming it (detail, transcript) is a leak.
	function sessionFrames(browser: ProcessBrowser, sessionId: string) {
		return browser.frames
			.filter(
				({ message }) =>
					message["sessionId"] === sessionId &&
					message["type"] !== "permission_pending",
			)
			.map(({ message }) => message["type"]);
	}

	function persistedStatus(
		fixture: ProcessHarness,
		slug: string,
		sessionId: string,
	) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const row = db
				.prepare("SELECT status FROM sessions WHERE id = ? AND project_id = ?")
				.get(sessionId, slug) as { status: string } | undefined;
			return row?.status;
		} finally {
			db.close();
		}
	}

	const permission = (id: string, sessionID: string) => ({
		id,
		sessionID,
		permission: "bash",
		patterns: ["echo reconcile"],
		metadata: {},
		always: [],
	});

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["droppedEvents"] = fixture.opencodeDroppedEvents();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				const prefix =
					evidence["ticket"] === "conduit-test-rqbc.3" ? "rqbc-3" : "pa3r-4";
				writeFileSync(
					`test-results/${prefix}-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	// The card is a pending_approvals row, so the reconnect's re-emitted ask is
	// idempotent: each browser holds every project's prompt exactly once (ni8.9,
	// 82tn.13), each naming its own session in its own project.
	it("keeps each project's pending prompt once across a reconnect, never across projects", async () => {
		const fixture = await start("reconnect");
		const a = await fixture.connect();
		const sessionA = await a.createSession("Project A", "opencode", "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Project B", "opencode", "opencode");
		await fixture.addOpenCodePrompt(
			"permission",
			fixture.projectDir,
			permission("pa4-a", sessionA),
		);
		await fixture.addOpenCodePrompt(
			"permission",
			directoryB,
			permission("pa4-b", sessionB),
		);
		// Every tab gets both projects' cards (82tn.13).
		for (const tab of [a, b])
			for (const id of ["pa4-a", "pa4-b"])
				await tab.waitFor(
					(message) =>
						fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
						id,
				);

		const cursorA = a.frames.length;
		const cursorB = b.frames.length;
		await fixture.closeOpenCodeStreams();
		await vi.waitFor(
			() => {
				expect(
					fixture
						.opencodeStreamConnections()
						.filter(({ action }) => action === "open"),
				).toHaveLength(2);
			},
			{ timeout: 15_000 },
		);
		// Live events after recovery are the barrier for the exactly-once counts.
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(fixture.projectDir),
			payload: {
				id: "evt_pa4-a-barrier",
				type: "permission.asked",
				properties: permission("pa4-a-barrier", sessionA),
			},
		});
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(directoryB),
			payload: {
				id: "evt_pa4-b-barrier",
				type: "permission.asked",
				properties: permission("pa4-b-barrier", sessionB),
			},
		});
		for (const [tab, cursor] of [
			[a, cursorA],
			[b, cursorB],
		] as const)
			for (const id of ["pa4-a-barrier", "pa4-b-barrier"])
				await tab.waitFor(
					(message) =>
						fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
						id,
					cursor,
				);
		const ownA = { project: "process-test", sessionId: sessionA };
		const ownB = { project: slugB, sessionId: sessionB };
		const seen = {
			a: { a: cards(fixture, a, "pa4-a"), b: cards(fixture, a, "pa4-b") },
			b: { a: cards(fixture, b, "pa4-a"), b: cards(fixture, b, "pa4-b") },
			leaks: {
				a: sessionFrames(a, sessionB),
				b: sessionFrames(b, sessionA),
			},
		};
		evidence["recoveredPromptCards"] = seen;
		expect(seen).toEqual({
			a: { a: [ownA], b: [ownB] },
			b: { a: [ownA], b: [ownB] },
			leaks: { a: [], b: [] },
		});
	}, 90_000);

	it("stores a recovered permission and question once across two reconnects and a daemon restart", async () => {
		const fixture = await start("recovered-asks");
		evidence["ticket"] = "conduit-test-rqbc.3";
		let browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Recovered asks",
			"opencode",
			"opencode",
		);
		const permissionId = "rqbc3-permission";
		const questionId = "rqbc3-question";
		const question = (id: string) => ({
			id,
			sessionID: sessionId,
			questions: [
				{
					question: "Proceed?",
					header: "Proceed",
					options: [{ label: "Yes" }],
				},
			],
		});
		const snapshot = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return {
					canonical: db
						.prepare<
							[string, string, string],
							{
								kind: string;
								requestId: string;
								eventId: string;
								sequence: number;
							}
						>(`SELECT type AS kind, json_extract(data, '$.providerRequestId') AS requestId,
						event_id AS eventId, sequence FROM events
						WHERE session_id = ? AND type IN ('permission.asked', 'question.asked')
						AND json_extract(data, '$.providerRequestId') IN (?, ?) ORDER BY type, sequence`)
						.all(sessionId, permissionId, questionId),
				};
			} finally {
				db.close();
			}
		};
		await fixture.addOpenCodePrompt(
			"permission",
			fixture.projectDir,
			permission(permissionId, sessionId),
		);
		await fixture.addOpenCodePrompt(
			"question",
			fixture.projectDir,
			question(questionId),
		);
		await browser.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				permissionId,
		);
		await browser.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
					questionId,
		);
		const initial = snapshot();
		const expected = [
			{ kind: "permission.asked", requestId: permissionId },
			{ kind: "question.asked", requestId: questionId },
		];
		expect(
			initial.canonical.map(({ kind, requestId }) => ({ kind, requestId })),
		).toEqual(expected);
		evidence["initial"] = initial;

		// Each marker exists only in the provider snapshot. Receiving it proves
		// reconciliation ingested both earlier asks, even if they wrote no rows.
		await fixture.dropOpenCodeEvents([{ type: "question.asked" }]);
		for (let reconnect = 1; reconnect <= 2; reconnect++) {
			const markerId = `rqbc3-reconnect-${reconnect}`;
			await fixture.addOpenCodePrompt(
				"question",
				fixture.projectDir,
				question(markerId),
			);
			await fixture.closeOpenCodeStreams();
			await browser.waitFor(
				(message) =>
					message["type"] === "question_pending" &&
					fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
						markerId,
			);
			const recovered = snapshot();
			evidence[`reconnect${reconnect}`] = recovered;
			expect(recovered).toEqual(initial);
		}

		const restartMarker = "rqbc3-restart";
		await fixture.addOpenCodePrompt(
			"question",
			fixture.projectDir,
			question(restartMarker),
		);
		await fixture.terminate();
		await fixture.restart();
		browser = await fixture.connect(sessionId);
		await browser.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
					restartMarker,
		);
		const restarted = snapshot();
		evidence["restart"] = restarted;
		expect(restarted).toEqual(initial);
	}, 90_000);

	it("reconciles a relay that subscribes after the stream is connected", async () => {
		const fixture = await start("late-subscriber");
		const a = await fixture.connect();
		// Events are passive: the first OpenCode use opens the shared stream.
		await a.createSession("Project A", "opencode", "opencode");
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open"),
			).toHaveLength(1);
		});
		// State exists before project B's relay subscribes, so its live events
		// reach no relay and only the subscribe-time reconcile can deliver it.
		const directoryB = join(fixture.root, "project-b");
		mkdirSync(directoryB, { recursive: true });
		const sessionB = "ses_pa4_late";
		writeFileSync(
			join(fixture.configDir, "fake-opencode-sessions.json"),
			JSON.stringify([
				{
					id: sessionB,
					slug: "late-session",
					version: "1.18.34",
					projectID: "global",
					directory: realpathSync(directoryB),
					title: "Late B",
					time: { created: Date.now(), updated: Date.now() },
				},
			]),
		);
		await fixture.setOpenCodeStatus(directoryB, sessionB, { type: "busy" });
		await fixture.addOpenCodePrompt(
			"permission",
			directoryB,
			permission("pa4-late", sessionB),
		);
		const slugB = await addProject(fixture, directoryB);
		// Project relays start lazily, so B's relay subscribes on first connect.
		const b = await fixture.connect(undefined, undefined, slugB);
		for (const tab of [b, a])
			await tab.waitFor(
				(message) =>
					fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
					"pa4-late",
			);
		await vi.waitFor(
			() => expect(persistedStatus(fixture, slugB, sessionB)).toBe("busy"),
			{ timeout: 15_000 },
		);
		const late = { project: slugB, sessionId: sessionB };
		const seen = {
			b: cards(fixture, b, "pa4-late"),
			a: cards(fixture, a, "pa4-late"),
			aLeak: sessionFrames(a, sessionB),
		};
		evidence["lateSubscriber"] = {
			status: persistedStatus(fixture, slugB, sessionB),
			seen,
		};
		expect(seen).toEqual({ b: [late], a: [late], aLeak: [] });
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ action }) => action === "open"),
		).toHaveLength(1);
	}, 90_000);

	it("settles a session to idle from the status poll when its idle event is dropped", async () => {
		const fixture = await start("dropped-idle");
		const a = await fixture.connect();
		const sessionA = await a.createSession("Busy A", "opencode", "opencode");
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open"),
			).toHaveLength(1);
		});
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionA, {
			type: "busy",
		});
		await vi.waitFor(
			() =>
				expect(persistedStatus(fixture, "process-test", sessionA)).toBe("busy"),
			{ timeout: 15_000 },
		);
		await fixture.dropOpenCodeEvents([
			{ type: "session.status", status: "idle" },
		]);
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionA, {
			type: "idle",
		});
		expect(fixture.opencodeDroppedEvents()).toHaveLength(1);
		await vi.waitFor(
			() =>
				expect(persistedStatus(fixture, "process-test", sessionA)).toBe("idle"),
			{ timeout: 15_000 },
		);
		evidence["droppedIdle"] = {
			sessionA,
			status: persistedStatus(fixture, "process-test", sessionA),
		};
	}, 90_000);
});
