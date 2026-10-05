import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveProject } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: prompts asked while the stream was down are lost, one
// project's prompt leaks into another, a reconnect re-delivers a prompt once
// per subscriber, a relay joining a live stream misses state, and a dropped
// idle event leaves a session busy forever.
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
		const result = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new SaveProject({ folders: [directory] }),
		);
		return result.savedSlug;
	}

	function requests(browser: ProcessBrowser, id: string, cursor = 0) {
		return browser.frames
			.slice(cursor)
			.filter(
				({ message }) =>
					message["type"] === "permission_request" &&
					message["requestId"] === id,
			).length;
	}

	function persistedStatus(
		fixture: ProcessHarness,
		slug: string,
		sessionId: string,
	) {
		const db = new Database(fixture.projectStorePath(slug), { readonly: true });
		try {
			const row = db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string } | undefined;
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
				writeFileSync(
					`test-results/pa3r-4-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("re-delivers each project's pending prompt once after a reconnect, never across projects", async () => {
		const fixture = await start("reconnect");
		const a = await fixture.connect();
		const sessionA = await a.createSession("Project A", undefined, "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Project B", undefined, "opencode");
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
		await a.waitFor((message) => message["requestId"] === "pa4-a");
		await b.waitFor((message) => message["requestId"] === "pa4-b");

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
		await a.waitFor((message) => message["requestId"] === "pa4-a", cursorA);
		await b.waitFor((message) => message["requestId"] === "pa4-b", cursorB);
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
		await a.waitFor(
			(message) => message["requestId"] === "pa4-a-barrier",
			cursorA,
		);
		await b.waitFor(
			(message) => message["requestId"] === "pa4-b-barrier",
			cursorB,
		);
		const counts = {
			a: {
				own: requests(a, "pa4-a", cursorA),
				other: requests(a, "pa4-b"),
			},
			b: {
				own: requests(b, "pa4-b", cursorB),
				other: requests(b, "pa4-a"),
			},
		};
		evidence["recoveredPromptCounts"] = counts;
		expect(counts).toEqual({
			a: { own: 1, other: 0 },
			b: { own: 1, other: 0 },
		});
	}, 90_000);

	it("reconciles a relay that subscribes after the stream is connected", async () => {
		const fixture = await start("late-subscriber");
		const a = await fixture.connect();
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
		await b.waitFor((message) => message["requestId"] === "pa4-late");
		await vi.waitFor(
			() => expect(persistedStatus(fixture, slugB, sessionB)).toBe("busy"),
			{ timeout: 15_000 },
		);
		const counts = {
			b: requests(b, "pa4-late"),
			aLeak: requests(a, "pa4-late"),
		};
		evidence["lateSubscriber"] = {
			status: persistedStatus(fixture, slugB, sessionB),
			counts,
		};
		expect(counts).toEqual({ b: 1, aLeak: 0 });
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ action }) => action === "open"),
		).toHaveLength(1);
	}, 90_000);

	it("settles a session to idle from the status poll when its idle event is dropped", async () => {
		const fixture = await start("dropped-idle");
		const a = await fixture.connect();
		const sessionA = await a.createSession("Busy A", undefined, "opencode");
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
