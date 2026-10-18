import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function ledger(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const column = (sql: string) =>
			(db.prepare(sql).all(sessionId) as Array<{ value: string }>).map(
				({ value }) => value,
			);
		return {
			status: column("SELECT status AS value FROM sessions WHERE id = ?")[0],
			queued: column(
				"SELECT input_id AS value FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at",
			),
			sent: column(
				"SELECT json_extract(data, '$.inputId') AS value FROM events WHERE session_id = ? AND type = 'input.sent' ORDER BY sequence",
			),
			turns: column(
				"SELECT state AS value FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
			),
		};
	} finally {
		db.close();
	}
}

// The OpenCode status poll answers with a snapshot taken when it was sent.
// Failure cases: a snapshot sampled before a session went busy synthesizes
// idle for it on arrival, which settles the running turn and dispatches the
// next queued input; or the fence is so broad that a genuinely missed idle is
// never healed and the queue holds forever.
describe("a stale OpenCode status read", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("cannot settle a turn that went busy after the read was sent", async () => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart();
		const browser = await fixture.connect();
		const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
		const running = await browser.createSession(
			"Running",
			instanceId,
			"opencode",
		);
		const other = await browser.createSession("Other", instanceId, "opencode");
		const directory = realpathSync(fixture.projectDir);
		const statusReads = () =>
			fixture
				.opencodeRequests()
				.filter(({ url }) => url.split("?")[0] === "/session/status").length;

		// Another busy session keeps the poll running; its read is held while
		// `running` is still idle, so the snapshot omits `running`.
		await fixture.holdOpenCodeStatusReads();
		await fixture.setOpenCodeStatus(directory, other, { type: "busy" });
		await vi.waitFor(
			() => expect(fixture.opencodeHeldStatusReads()).toHaveLength(1),
			{ timeout: 15_000 },
		);
		const [held] = fixture.opencodeHeldStatusReads();

		// The next turn starts after the read was sent: a user message with no
		// reply yet, then busy. A queued input must wait for it.
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: `evt_${randomUUID()}`,
				type: "message.updated",
				properties: {
					info: {
						id: "msg_running_turn",
						sessionID: running,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		await fixture.setOpenCodeStatus(directory, running, { type: "busy" });
		const inputId = randomUUID();
		const accepted = await Effect.runPromise(
			browser.rpc.input.submit({
				sessionId: running,
				text: "after the running turn",
				inputId,
				originId: browser.originId,
				delivery: "queue",
			}),
		);
		expect(accepted).toEqual({
			ok: true,
			sessionId: running,
			handedOff: false,
		});
		await vi.waitFor(() =>
			expect(ledger(fixture, running)).toEqual({
				status: "busy",
				queued: [inputId],
				sent: [],
				turns: ["running"],
			}),
		);

		// The poll schedules its next read only after applying this answer.
		const readsBeforeRelease = statusReads();
		await fixture.releaseOpenCodeStatusReads();
		await vi.waitFor(
			() => expect(statusReads()).toBeGreaterThan(readsBeforeRelease),
			{ timeout: 15_000 },
		);
		// A later event on the same stream is persisted after anything the
		// stale answer emitted.
		await fixture.setOpenCodeStatus(directory, other, { type: "idle" });
		await vi.waitFor(() => expect(ledger(fixture, other).status).toBe("idle"));
		const afterStaleRead = ledger(fixture, running);
		expect(afterStaleRead).toEqual({
			status: "busy",
			queued: [inputId],
			sent: [],
			turns: ["running"],
		});

		// A genuinely missed idle is still healed by the next read.
		await fixture.dropOpenCodeEvents([
			{ type: "session.status", status: "idle" },
		]);
		await fixture.setOpenCodeStatus(directory, running, { type: "idle" });
		// input.sent can land before the prompt request reaches OpenCode.
		const prompts = () =>
			fixture
				.opencodeRequests()
				.filter(
					({ method, url }) =>
						method === "POST" &&
						url.split("?")[0] === `/session/${running}/prompt_async`,
				);
		await vi.waitFor(
			() => {
				expect(ledger(fixture, running)).toMatchObject({
					queued: [],
					sent: [inputId],
				});
				expect(prompts()).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);

		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-1z3c-stale-status-read.json",
			JSON.stringify(
				{
					running,
					other,
					inputId,
					heldRead: held,
					afterStaleRead,
					final: ledger(fixture, running),
					droppedEvents: fixture.opencodeDroppedEvents(),
					prompts: prompts(),
				},
				null,
				2,
			),
		);
	}, 90_000);
});
