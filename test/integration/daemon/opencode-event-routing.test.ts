/*
 * One OpenCode stream per daemon instance routes each event to its session's project (82tn.16, S3).
 * Failure modes, written before the code (numbering from the lane 16f audit):
 * 1. Two projects that share a folder both ingest one session's event, so its transcript doubles.
 * 3. A removed project's session still ingests an event in flight through a project sharing its folder.
 * 4. A project no tab has opened since a daemon restart never ingests its OpenCode sessions' events.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

describe("82tn.16: daemon OpenCode event routing", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = { bead: "conduit-test-82tn.16", scenario: name };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		await harness.restart();
		return harness;
	}

	/** Project B: its own main folder, plus project A's main folder when shared. */
	async function addProjectB(fixture: ProcessHarness, shared: boolean) {
		const main = `${fixture.root}/project-b`;
		mkdirSync(main, { recursive: true });
		const { savedSlug } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: shared ? [main, fixture.projectDir] : [main],
		});
		return { slug: String(savedSlug), main };
	}

	/** An assistant text part carrying `marker`, as OpenCode streams it. */
	async function emitText(
		fixture: ProcessHarness,
		directory: string,
		sessionID: string,
		marker: string,
	) {
		const messageID = `msg_${marker}`;
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: `evt_${randomUUID()}`,
				type: "message.updated",
				properties: {
					info: {
						id: messageID,
						sessionID,
						role: "assistant",
						time: { created: Date.now() },
					},
				},
			},
		});
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: `evt_${randomUUID()}`,
				type: "message.part.updated",
				properties: {
					part: {
						id: `prt_${marker}`,
						sessionID,
						messageID,
						type: "text",
						text: marker,
					},
				},
			},
		});
	}

	/** A session error carrying `marker`: no message state, so nothing downstream can absorb a second copy. */
	async function emitError(
		fixture: ProcessHarness,
		directory: string,
		sessionID: string,
		marker: string,
	) {
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: `evt_${randomUUID()}`,
				type: "session.error",
				properties: {
					sessionID,
					error: { name: "UnknownError", data: { message: marker } },
				},
			},
		});
	}

	/** An ask is a processing barrier: once its card shows, every earlier event on that stream was handled. */
	async function barrier(
		fixture: ProcessHarness,
		tab: ProcessBrowser,
		directory: string,
		sessionID: string,
	) {
		const id = `barrier-${randomUUID()}`;
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: `evt_${id}`,
				type: "permission.asked",
				properties: {
					id,
					sessionID,
					permission: "bash",
					patterns: ["echo routing"],
					metadata: {},
					always: [],
				},
			},
		});
		await tab.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) === id,
		);
	}

	/** The stored events whose data carries `marker`, by session. */
	function ingested(fixture: ProcessHarness, marker: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare<[string], { sessionId: string; type: string }>(
					"SELECT session_id AS sessionId, type FROM events WHERE data LIKE ? ORDER BY sequence",
				)
				.all(`%${marker}%`);
		} finally {
			db.close();
		}
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/82tn-16-opencode-routing-${scenario}.json`,
					`${JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2)}\n`,
				);
				harness = undefined;
			}
		}
	});

	// 1: project B also lists A's folder, so both projects hear that folder's events.
	it("ingests a shared folder's session event once, into the session's own project", async () => {
		const fixture = await start("shared-folder");
		const tabA = await fixture.connect();
		const sessionA = await tabA.createSession("A", "opencode", "opencode");
		const b = await addProjectB(fixture, true);
		const tabB = await fixture.connect(undefined, undefined, b.slug);
		const sessionB = await tabB.createSession("B", "opencode", "opencode");
		evidence["sessions"] = { sessionA, sessionB, slugB: b.slug };

		await emitText(fixture, fixture.projectDir, sessionA, "ROUTE_SHARED_A");
		await emitText(fixture, b.main, sessionB, "ROUTE_OWN_B");
		await emitError(
			fixture,
			fixture.projectDir,
			sessionA,
			"ROUTE_SHARED_A_ERROR",
		);
		await emitError(fixture, b.main, sessionB, "ROUTE_OWN_B_ERROR");
		await barrier(fixture, tabA, fixture.projectDir, sessionA);
		await barrier(fixture, tabA, b.main, sessionB);

		const routed = {
			a: ingested(fixture, "ROUTE_SHARED_A"),
			b: ingested(fixture, "ROUTE_OWN_B"),
		};
		evidence["routed"] = routed;
		// B's own folder has one listener, so B's count is what one delivery stores.
		expect(routed.b.length).toBeGreaterThan(0);
		expect(routed.b.every(({ sessionId }) => sessionId === sessionB)).toBe(
			true,
		);
		expect(routed.a).toEqual(
			routed.b.map((row) => ({ ...row, sessionId: sessionA })),
		);
	});

	// 3: A is removed, so its sessions are no registered project's; B still hears A's folder.
	it("drops a removed project's session event in flight through a project sharing its folder", async () => {
		const fixture = await start("removed-in-flight");
		const tabA = await fixture.connect();
		const sessionA = await tabA.createSession("A", "opencode", "opencode");
		const b = await addProjectB(fixture, true);
		const tabB = await fixture.connect(undefined, undefined, b.slug);
		const sessionB = await tabB.createSession("B", "opencode", "opencode");
		evidence["sessions"] = { sessionA, sessionB, slugB: b.slug };

		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		await emitText(fixture, fixture.projectDir, sessionA, "ROUTE_REMOVED_A");
		await emitError(
			fixture,
			fixture.projectDir,
			sessionA,
			"ROUTE_REMOVED_A_ERROR",
		);
		await emitText(fixture, b.main, sessionB, "ROUTE_KEPT_B");
		await barrier(fixture, tabB, fixture.projectDir, sessionB);

		const routed = {
			removed: ingested(fixture, "ROUTE_REMOVED_A"),
			kept: ingested(fixture, "ROUTE_KEPT_B").map(({ sessionId }) => sessionId),
		};
		evidence["routed"] = routed;
		expect(routed.removed).toEqual([]);
		expect(routed.kept.length).toBeGreaterThan(0);
		expect(new Set(routed.kept)).toEqual(new Set([sessionB]));
	});

	// 4: after a restart only project A has a tab; B's session must still ingest.
	it("ingests an unopened project's session events after a daemon restart", async () => {
		const fixture = await start("unopened-after-restart");
		const b = await addProjectB(fixture, false);
		const tabB = await fixture.connect(undefined, undefined, b.slug);
		const sessionB = await tabB.createSession("B", "opencode", "opencode");
		evidence["sessions"] = { sessionB, slugB: b.slug };

		await fixture.terminate();
		await fixture.restart();
		const tabA = await fixture.connect();
		// test-waits-allow polling: the harness counts stream opens; no frame announces them.
		await vi.waitFor(() =>
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open").length,
			).toBeGreaterThan(1),
		);
		await emitText(fixture, b.main, sessionB, "ROUTE_UNOPENED_B");
		// test-waits-allow polling: no tab shows B, so the store is the only witness.
		await vi.waitFor(
			() => {
				const rows = ingested(fixture, "ROUTE_UNOPENED_B");
				evidence["ingested"] = rows;
				expect(rows.length).toBeGreaterThan(0);
				expect(new Set(rows.map(({ sessionId }) => sessionId))).toEqual(
					new Set([sessionB]),
				);
			},
			{ timeout: 15_000, interval: 250 },
		);
		evidence["tabAFrames"] = tabA.frames.length;
	});
});
