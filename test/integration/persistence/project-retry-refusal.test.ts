import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import { decideDurableSendTurnCommand } from "../../../src/lib/provider/orchestration-decider.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const scenarios: Record<string, unknown>[] = [];
afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn10-4-fix10-retries.json",
		JSON.stringify(scenarios, null, 2),
	);
});

// Real admission, provider terminal, drain and reopened SQLite stores. A retry's
// preceding run may have started or ended before intake; neither claims its retry.
// Refusal must be durable once, without resending or rewriting the prior terminal.
it.each(
	(["opencode", "claude", "cursor"] as const).flatMap((provider) =>
		(["project_inactive", "project_unavailable"] as const).flatMap((code) =>
			[false, true].map((started) => ({ provider, code, started })),
		),
	),
)("refuses an unclaimed automatic retry: $provider $code started=$started", async ({
	provider,
	code,
	started,
}) => {
	const root = mkdtempSync(join(tmpdir(), "retry-refusal-"));
	const snapshots: unknown[] = [];
	try {
		for (let restart = 0; restart < 3; restart++) {
			const persistence = makePersistenceEffectLayer(
				join(root, "events.db"),
				"project",
			);
			const runtime = ManagedRuntime.make(
				Layer.mergeAll(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			);
			try {
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						const persist = yield* ClaudeEventPersistEffectTag;
						const ingestion = yield* ProviderRuntimeIngestionTag;
						if (restart === 0) {
							yield* commit([
								canonicalEvent("session.created", "session", {
									sessionId: "session",
									provider,
									title: "Automatic retry",
								}),
							]);
							const repository = new DurableCommandCommitRepository(
								sql,
								"project",
							);
							yield* commit.write((project) =>
								repository
									.commit(
										decideDurableSendTurnCommand({
											commandId: "input",
											sessionId: "session",
											providerId: provider,
											fingerprintHash: "retry-fixture",
											nowMs: 1,
											requestSequence: 1,
											events: [],
											payloadJson: JSON.stringify({
												sessionId: "session",
												inputId: "input",
												prompt: "Retry this prompt",
												workspaceRoot: root,
												extraFolders: [],
												providerState: {},
											}),
										}),
									)
									.pipe(Effect.flatMap(project)),
							);
							yield* sql`UPDATE provider_command_outbox SET status = 'running', attempt_count = 1`;
							const [command] = yield* sql<{
								run_id: string;
							}>`SELECT run_id FROM provider_command_outbox`;
							ok(command);
							if (started) {
								yield* ingestion.ingest(
									providerRuntimeEvent(
										"run.started",
										"session",
										{
											requestedRunId: command.run_id,
											inputId: "input",
										},
										{ runId: command.run_id, providerId: provider },
									),
								);
								yield* persist.persistUserMessage(
									"session",
									"Retry this prompt",
									{
										messageId: "input",
										inputId: "input",
										runId: command.run_id,
										provider,
									},
								);
							}
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"turn.error",
									"session",
									{
										messageId: "input",
										error: "Temporary network error",
										code: "network_error",
										retryable: true,
										retryAt: 1,
									},
									{ runId: command.run_id, providerId: provider },
								),
							);
							expect(
								yield* sql`SELECT status, error_code FROM provider_command_outbox`,
							).toEqual([
								{ status: "retryable_failed", error_code: "network_error" },
							]);
							yield* sql.unsafe("CREATE TABLE refusals (command_id TEXT)");
							yield* sql.unsafe(`CREATE TRIGGER count_refusals AFTER UPDATE ON command_receipts
							WHEN NEW.error_code IN ('project_inactive', 'project_unavailable')
							BEGIN INSERT INTO refusals VALUES (NEW.command_id); END`);
						}
						const reactor = new ProviderSideEffectReactor({
							sql,
							write: commit.write,
							ingestion,
							registry: new ProviderRegistry(),
							persistUserMessage: persist.persistUserMessage,
							isProjectReady: () =>
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "conduit",
										operation: "executeCommand",
										code,
										cause: code,
									}),
								),
						});
						for (let sweep = 0; sweep < 3; sweep++) yield* reactor.drain();
						const snapshot = {
							commands:
								yield* sql`SELECT status, error_code, attempt_count, next_attempt_at FROM provider_command_outbox`,
							receipts: yield* sql<{
								status: string;
								error_code: string | null;
								error: string | null;
								updated_at: number;
							}>`SELECT status, error_code, error, updated_at FROM command_receipts`,
							refusals: yield* sql`SELECT command_id FROM refusals`,
							runs: yield* sql`SELECT status FROM provider_runs ORDER BY rowid`,
							messages: yield* sql`SELECT id FROM messages WHERE role = 'user'`,
							text: yield* sql`SELECT text FROM message_parts WHERE type = 'text'`,
							errors:
								yield* sql`SELECT json_extract(data, '$.code') AS code FROM events WHERE type = 'turn.error' ORDER BY sequence`,
						};
						snapshots.push(snapshot);
						expect(snapshot.commands).toEqual([
							{
								status: code === "project_inactive" ? "cancelled" : "failed",
								error_code: code,
								attempt_count: 1,
								next_attempt_at: null,
							},
						]);
						expect(snapshot.receipts).toMatchObject([
							{ status: "side_effect_failed", error_code: code },
						]);
						expect(
							JSON.parse(snapshot.receipts[0]?.error ?? "null"),
						).toMatchObject({
							_tag: "ProviderInstanceFailure",
							providerId: provider,
							operation: "send_turn",
							code,
						});
						expect(snapshot.refusals).toEqual([{ command_id: "input" }]);
						expect(snapshot.runs).toEqual([
							{ status: "error" },
							{ status: "error" },
						]);
						expect(snapshot.messages).toEqual([{ id: "input" }]);
						expect(snapshot.text).toEqual([{ text: "Retry this prompt" }]);
						expect(snapshot.errors).toEqual([
							{ code: "network_error" },
							{ code },
						]);
						if (restart > 0) expect(snapshot).toEqual(snapshots[0]);
					}),
				);
			} finally {
				await runtime.dispose();
			}
		}
		scenarios.push({ provider, code, started, snapshots });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
