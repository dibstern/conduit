import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { writeProviderCommandOutboxProof } from "../../helpers/provider-command-outbox-proof.js";

const kinds = [
	"interrupt_turn",
	"resolve_permission",
	"resolve_question",
	"end_session",
] as const;
const evidence: Record<string, unknown>[] = [];

function sdkProof(harness: ProcessHarness) {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterAll(() => {
	writeProviderCommandOutboxProof(evidence);
});

describe("command outbox crash proof through the real daemon and stub SDK", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it.each(
		kinds.flatMap((kind) =>
			[false, true].map((accepted) => ({ kind, accepted })),
		),
	)("$kind survives a crash, provider already accepted=$accepted", async ({
		kind,
		accepted,
	}) => {
		const record: Record<string, unknown> = {
			kind,
			crashPoint: accepted
				? "provider-acceptance-before-receipt"
				: "commit-before-delivery",
			passed: false,
		};
		evidence.push(record);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(`Outbox ${kind}`);
		record["sessionId"] = sessionId;
		const prompt =
			kind === "resolve_permission"
				? "approval-outbox"
				: kind === "resolve_question"
					? "question-fixed-outbox"
					: kind === "interrupt_turn"
						? "upgrade-long-turn"
						: "outbox-end";
		const send = browser.send(sessionId, prompt).catch(() => undefined);
		let request: Record<string, unknown> = {};
		if (kind === "resolve_permission" || kind === "resolve_question")
			request = await browser.waitFor(
				(frame) =>
					frame["type"] ===
					(kind === "resolve_permission"
						? "permission_pending"
						: "question_pending"),
				0,
				30_000,
			);
		else if (kind === "interrupt_turn")
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
					).toBe(true),
				{ timeout: 15_000 },
			);
		else await send;
		const db = new Database(harness.daemonStorePath());
		try {
			db.exec(`CREATE TRIGGER hold_control BEFORE UPDATE OF status ON provider_command_outbox
					WHEN NEW.effect_type = '${kind}' AND NEW.status = '${accepted ? "completed" : "running"}'
					BEGIN SELECT RAISE(IGNORE); END`);
			const commandId = randomUUID();
			const control = (
				kind === "interrupt_turn"
					? Effect.runPromise(
							browser.rpc.CancelSession({ sessionId, commandId }),
						)
					: kind === "resolve_permission"
						? browser.answerApproval(request, "allow")
						: kind === "resolve_question"
							? Effect.runPromise(
									browser.rpc.AnswerQuestion({
										projectSlug: "process-test",
										originId: browser.originId,
										commandId,
										toolId: String(request["toolId"]),
										answers: { "0": "Continue" },
									}),
								)
							: browser.reloadSession(sessionId)
			).catch((error: unknown) => {
				record["controlError"] = String(error);
			});
			const nativeKind =
				kind === "interrupt_turn"
					? "query-interrupted"
					: kind === "resolve_permission"
						? "approval"
						: kind === "resolve_question"
							? "prompt-answer"
							: "query-closed";
			await vi.waitFor(
				() => {
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = ?",
							)
							.get(sessionId, kind),
					).toEqual({ status: accepted ? "running" : "pending" });
					if (accepted)
						expect(
							sdkProof(harness).filter((mark) => mark["kind"] === nativeKind),
						).toHaveLength(1);
				},
				{ timeout: 10_000 },
			);
			const target = db
				.prepare(
					"SELECT command_id, provider_process_id, run_id, payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = ?",
				)
				.get(sessionId, kind) as {
				command_id: string;
				provider_process_id: string;
				run_id: string | null;
				payload_json: string;
			};
			expect(target.provider_process_id).toEqual(expect.any(String));
			record["target"] = target;
			record["targetRuns"] = db
				.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
				.all(sessionId);
			record["nativeCallsBeforeCrash"] = sdkProof(harness).filter(
				(mark) => mark["kind"] === nativeKind,
			).length;
			expect(record["nativeCallsBeforeCrash"]).toBe(accepted ? 1 : 0);
			expect(
				db
					.prepare("SELECT status FROM command_receipts WHERE command_id = ?")
					.get(target.command_id),
			).toEqual({ status: "side_effect_requested" });
			await harness.kill();
			await Promise.all([send, control]);
			db.exec("DROP TRIGGER hold_control");
			await harness.restart();
			await harness.connect(sessionId);
			await vi.waitFor(
				() => {
					const outcome = db
						.prepare(
							"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(target.command_id) as {
						status: string;
						error_code: string | null;
					};
					if (kind === "end_session" && accepted)
						expect(outcome).toEqual({
							status: "cancelled",
							error_code: "provider_process_gone",
						});
					else
						expect(outcome).toEqual({ status: "completed", error_code: null });
				},
				{ timeout: 15_000 },
			);
			const sdk = sdkProof(harness);
			const deliveries = sdk.filter(
				(mark) =>
					mark["kind"] === "runner-control" &&
					mark["commandId"] === target.command_id,
			);
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.["runnerId"]).toBe(target.provider_process_id);
			expect(sdk.filter((mark) => mark["kind"] === nativeKind)).toHaveLength(1);
			if (kind === "interrupt_turn")
				writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			record["nativeCallCount"] = sdk.filter(
				(mark) => mark["kind"] === nativeKind,
			).length;
			record["nativeCalls"] = sdk.filter((mark) => mark["kind"] === nativeKind);
			record["deliveries"] = deliveries;
			record["passed"] = true;
		} finally {
			record["events"] = db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId);
			record["outcomes"] = db
				.prepare(
					"SELECT command_id, effect_type, provider_process_id, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
				)
				.all(sessionId);
			record["receipts"] = db
				.prepare(
					"SELECT command_id, status, error_code FROM command_receipts WHERE session_id = ?",
				)
				.all(sessionId);
			record["runs"] = db
				.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
				.all(sessionId);
			record["process"] = harness.proof();
			db.close();
		}
	}, 90_000);
});
