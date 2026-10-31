import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const text =
	"No response for 2 minutes. The model may be unavailable or your usage quota may be used up. Stop this turn to try a different model.";

describe("turn.notice through durable ingestion and transcript reload", () => {
	let harness: EffectProjectionHarness;
	beforeEach(async () => {
		harness = makeEffectProjectionHarness();
		await harness.ingest(
			providerRuntimeEvent("session.created", "s", {
				sessionId: "s",
				title: "Silent turn",
				provider: "claude",
			}),
		);
		await harness.query(
			"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('run-a', 's', 'pending', 1)",
		);
		await harness.query(`INSERT INTO provider_command_outbox
			(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'a', 'test-project', 's', 'claude', 'send_turn', 'run-a', '{}', 'running', 1, 1, 1)`);
		await harness.query(
			"INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at) VALUES ('a', 's', 'test-project', 'side_effect_requested', 1, 1)",
		);
		await harness.ingest(
			providerRuntimeEvent(
				"message.created",
				"s",
				{ messageId: "user-a", sessionId: "s", role: "user" },
				{ runId: "run-a" },
			),
		);
		await harness.ingest(
			providerRuntimeEvent(
				"run.started",
				"s",
				{ inputId: "a", requestedRunId: "run-a", userMessageId: "user-a" },
				{ runId: "run-a" },
			),
		);
		await harness.ingest(
			providerRuntimeEvent(
				"message.created",
				"s",
				{ messageId: "assistant-a", sessionId: "s", role: "assistant" },
				{ runId: "run-a", eventId: "assistant-created" },
			),
		);
		await harness.ingest(
			providerRuntimeEvent(
				"session.status",
				"s",
				{ sessionId: "s", status: "busy" },
				{ runId: "run-a" },
			),
		);
	});
	afterEach(async () => {
		await harness.dispose();
	});

	it("reloads an informational notice without ending or altering active work", async () => {
		const before = await harness.query(
			"SELECT status, started_at, completed_at FROM provider_runs WHERE id = 'run-a'",
		);
		const notice = providerRuntimeEvent(
			"turn.notice",
			"s",
			{ text },
			{ runId: "run-a" },
		);
		await harness.ingest(notice);
		const events = await harness.storedEvents("s");
		await harness.reproject(
			events.filter((event) => event.type === "turn.notice"),
		);
		expect(
			await harness.query(
				"SELECT status, started_at, completed_at FROM provider_runs WHERE id = 'run-a'",
			),
		).toEqual(before);
		expect(
			await harness.query("SELECT state, completed_at FROM turns"),
		).toEqual([{ state: "running", completed_at: null }]);
		expect(
			await harness.query("SELECT status FROM provider_command_outbox"),
		).toEqual([{ status: "running" }]);
		expect(await harness.query("SELECT status FROM command_receipts")).toEqual([
			{ status: "side_effect_requested" },
		]);
		expect(
			await harness.query("SELECT status FROM sessions WHERE id = 's'"),
		).toEqual([{ status: "busy" }]);
		expect(
			await harness.query(
				"SELECT is_streaming FROM messages WHERE id = 'assistant-a'",
			),
		).toEqual([{ is_streaming: 1 }]);
		expect(
			await harness.query(
				"SELECT type, text, metadata FROM message_parts WHERE metadata = '{\"notice\":true}'",
			),
		).toEqual([{ type: "text", text, metadata: '{"notice":true}' }]);
		const history = messageRowsToHistory(
			await harness.sessionMessagesWithParts("s"),
			{ pageSize: 50 },
		).messages;
		expect(
			history
				.flatMap((message) => message.parts ?? [])
				.filter((part) => part.type === "notice"),
		).toMatchObject([{ type: "notice", text }]);
		expect(
			historyToChatMessages(history).filter(
				(message) => message.type === "system",
			),
		).toMatchObject([{ type: "system", variant: "info", text }]);
	});

	it("resolves a joined reservation to its accepted owner", async () => {
		await harness.query(
			"INSERT INTO provider_runs (id, session_id, status, requested_at, completed_at, joined_into) VALUES ('run-joined', 's', 'joined', 1, 2, 'run-a')",
		);
		await harness.ingest(
			providerRuntimeEvent(
				"turn.notice",
				"s",
				{ text },
				{ runId: "run-joined" },
			),
		);
		expect(
			await harness.query(
				"SELECT text FROM message_parts WHERE metadata = '{\"notice\":true}'",
			),
		).toEqual([{ text }]);
	});

	it.each([
		"running",
		"ended",
		"absent",
	] as const)("persists and reloads a session-scoped info banner when the Run is %s", async (runState) => {
		if (runState === "ended") {
			await harness.ingest(
				providerRuntimeEvent(
					"turn.completed",
					"s",
					{ messageId: "assistant-a" },
					{ runId: "run-a" },
				),
			);
		} else if (runState === "absent") {
			await harness.query("DELETE FROM provider_runs");
		}
		const before = await Promise.all([
			harness.query("SELECT status, completed_at FROM provider_runs"),
			harness.query("SELECT state, completed_at FROM turns"),
			harness.query("SELECT status FROM provider_command_outbox"),
			harness.query("SELECT status FROM command_receipts"),
			harness.query("SELECT status FROM sessions WHERE id = 's'"),
			harness.query(
				"SELECT is_streaming FROM messages WHERE id = 'assistant-a'",
			),
		]);
		await harness.ingest(providerRuntimeEvent("turn.notice", "s", { text }));
		await harness.reproject(
			(await harness.storedEvents("s")).filter(
				(event) => event.type === "turn.notice",
			),
		);
		expect(
			await harness.query(
				"SELECT type, text, metadata FROM message_parts WHERE metadata = '{\"notice\":true}'",
			),
		).toEqual([{ type: "text", text, metadata: '{"notice":true}' }]);
		const history = messageRowsToHistory(
			await harness.sessionMessagesWithParts("s"),
			{ pageSize: 50 },
		).messages;
		expect(
			history
				.flatMap((message) => message.parts ?? [])
				.filter((part) => part.type === "notice"),
		).toMatchObject([{ type: "notice", text }]);
		expect(
			historyToChatMessages(history).filter(
				(message) => message.type === "system",
			),
		).toEqual([
			expect.objectContaining({ type: "system", variant: "info", text }),
		]);
		expect(
			await Promise.all([
				harness.query("SELECT status, completed_at FROM provider_runs"),
				harness.query("SELECT state, completed_at FROM turns"),
				harness.query("SELECT status FROM provider_command_outbox"),
				harness.query("SELECT status FROM command_receipts"),
				harness.query("SELECT status FROM sessions WHERE id = 's'"),
				harness.query(
					"SELECT is_streaming FROM messages WHERE id = 'assistant-a'",
				),
			]),
		).toEqual(before);
	});

	it.each([
		"ended",
		"unaccepted",
		"foreign",
	] as const)("does not display a late or unaccepted notice (%s)", async (owner) => {
		if (owner === "ended") {
			await harness.ingest(
				providerRuntimeEvent(
					"turn.completed",
					"s",
					{ messageId: "assistant-a" },
					{ runId: "run-a" },
				),
			);
		} else if (owner === "unaccepted") {
			await harness.query(
				"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('run-pending', 's', 'pending', 1)",
			);
		}
		await harness.ingest(
			providerRuntimeEvent(
				"turn.notice",
				"s",
				{ text },
				{
					runId:
						owner === "ended"
							? "run-a"
							: owner === "unaccepted"
								? "run-pending"
								: "foreign-run",
				},
			),
		);
		expect(
			await harness.query(
				"SELECT text FROM message_parts WHERE metadata = '{\"notice\":true}'",
			),
		).toEqual([]);
	});
});
