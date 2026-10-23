// Failure modes: creation discovers Cursor or writes its state; Side Threads
// miss their inherited context; first-turn reads use the source or stale rows;
// empty forks or ordinary sessions acquire a seed from their own later messages.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../src/lib/domain/relay/Services/session-command.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeCursorRunnerDriver } from "../../../src/lib/provider/cursor/cursor-runner-driver.js";
import { makeCursorSessionRunner } from "../../../src/lib/provider/cursor/cursor-runner-payload.js";
import { teeCursorSdkPort } from "../../../src/lib/provider/cursor/sdk-trace.js";
import { createTraceCursorSdkPort } from "../../../src/lib/provider/cursor/sdk-trace-player.js";
import { renderForkDigest } from "../../../src/lib/provider/fork-digest.js";
import {
	cursorAccountResourcesFixture,
	cursorCredentialFixture,
} from "../../helpers/cursor-account-resources-fixture.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

it("creates Cursor forks and Side Threads locally and seeds their current inherited rows once", async () => {
	const root = mkdtempSync(join(tmpdir(), "cursor-fork-flow-"));
	const capture = join(root, "capture.jsonl");
	const trace = join(root, "replay.jsonl");
	const replay: unknown[] = readFileSync(
		resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
	replay.splice(1, 0, {
		kind: "credential.store",
		data: {
			apiKey: "[REDACTED]",
			backendUrl: "https://api2.cursor.sh",
			createdAtMs: 0,
		},
	});
	writeFileSync(
		trace,
		`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	const port = teeCursorSdkPort(createTraceCursorSdkPort(trace), capture);
	const credential = cursorCredentialFixture();
	const resources = cursorAccountResourcesFixture(port, {
		_tag: "Ready",
		credential,
	});
	const discover = vi.fn(() => Effect.die("Cursor called during creation"));
	const account = {
		driver: "cursor" as const,
		id: AccountIdSchema.make("cursor"),
		name: "Cursor",
		usageEligible: false,
	};
	const scenarios: Record<string, unknown>[] = [];
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"cursor-fork-flow",
	);
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					const read = yield* ReadQueryEffectTag;
					const state = yield* ProviderStateEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					yield* commit(
						[
							canonicalEvent("session.created", "source", {
								sessionId: "source",
								title: "Source",
								provider: "cursor",
							}),
							...sessionPickEvents("source", {
								harness: "cursor",
								model: { providerId: "cursor", modelId: "composer-2.5" },
								effort: "",
								contextWindow: "",
							}),
							canonicalEvent("run.requested", "source", {
								runId: "source-run",
								inputId: "question",
							}),
							canonicalEvent(
								"message.created",
								"source",
								{
									sessionId: "source",
									messageId: "question",
									role: "user",
								},
								{ createdAt: 1 },
							),
							canonicalEvent("run.started", "source", {
								inputId: "question",
								requestedRunId: "source-run",
							}),
							canonicalEvent("text.delta", "source", {
								messageId: "question",
								partId: "question:text",
								text: "Original source context",
							}),
							canonicalEvent(
								"message.created",
								"source",
								{
									sessionId: "source",
									messageId: "answer",
									parentID: "question",
									role: "assistant",
								},
								{ createdAt: 2 },
							),
							canonicalEvent("text.delta", "source", {
								messageId: "answer",
								partId: "answer:text",
								text: "Original answer",
							}),
							canonicalEvent("turn.completed", "source", {
								messageId: "answer",
							}),
						].map((event) => ({
							...event,
							provider: "cursor",
							metadata: { ...event.metadata, runId: "source-run" },
						})),
					);
					const fork = yield* forkSession("source");
					const side = yield* forkSession("source", {
						side: { title: "Side", inputId: "side-input" },
					});
					expect(discover).not.toHaveBeenCalled();
					expect(yield* state.getState(side.id)).toEqual({});
					expect(yield* state.getState(fork.id)).toEqual({});
					const creationProviderCalls = (
						existsSync(capture) ? readFileSync(capture, "utf8") : ""
					)
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { kind: string })
						.filter(({ kind }) => kind !== "trace.header");
					expect(creationProviderCalls).toEqual([]);
					expect(yield* read.getSession(side.id)).toMatchObject({
						parent_id: "source",
						side_thread: 1,
						permission_mode: "ask",
					});
					expect(yield* read.getSession(fork.id)).toMatchObject({
						forked_from: "source",
						parent_id: null,
					});
					// Change only the copied rows between creation and the first turn.
					yield* sql`UPDATE message_parts SET text = 'Fork-local context at first turn' WHERE id = ${`question:text_${side.id}`}`;
					const expectedDigest = renderForkDigest(
						yield* read.getSessionMessagesWithParts(side.id),
					);
					expect(expectedDigest).toContain("Fork-local context at first turn");
					expect(expectedDigest).not.toContain("Original source context");
					const driver = makeCursorRunnerDriver(resources, { read, state });
					const runner = yield* makeCursorSessionRunner(
						{
							workspaceRoot: root,
							daemonConfigDir: root,
							port,
							credential: () => credential,
							environment: () => ({}),
						},
						(output) =>
							Effect.gen(function* () {
								if (output.type === "event")
									yield* ingestion.ingest(output.event);
								if (output.type === "place-user-message")
									yield* persist.persistUserMessage(
										output.input.sessionId,
										output.input.text,
										{
											provider: "cursor",
											messageId: output.input.inputId,
											inputId: output.input.inputId,
											...(output.input.runId
												? { runId: output.input.runId }
												: {}),
										},
									);
								return {};
							}).pipe(
								Effect.mapError((cause) => ({
									operation: "cursor fixture output",
									message: String(cause),
								})),
							),
					);
					const send = (sessionId: string, prompt: string) =>
						Effect.gen(function* () {
							const inputId = `${sessionId}:${prompt}`;
							const runId = `run:${inputId}`;
							yield* commit([
								canonicalEvent(
									"run.requested",
									sessionId,
									{ runId, inputId },
									{ provider: "cursor", metadata: { runId } },
								),
							]);
							const prepared = yield* driver.prepareTurnEffect({
								sessionId,
								inputId,
								runId,
								prompt,
								history: [],
								providerState: {},
								workspaceRoot: root,
								extraFolders: [],
								permissionMode: "ask",
								model: { providerId: "cursor", modelId: "composer-2.5" },
								account,
							});
							const result = yield* runner.executeEffect({
								type: "send-turn",
								sinkId: `${sessionId}:${prompt}`,
								aborted: false,
								...prepared,
							});
							expect(result, JSON.stringify(result)).toMatchObject({
								status: "accepted",
							});
							const ended = yield* sql<{ run: string; turn: string }>`
								SELECT r.status AS run, t.state AS turn FROM provider_runs r
								JOIN turns t ON t.run_id = r.id AND t.session_id = r.session_id
								WHERE r.id = ${runId} AND r.session_id = ${sessionId}`.pipe(
								Effect.repeat({
									until: (rows) => rows[0]?.run === "completed",
									schedule: Schedule.spaced("10 millis"),
								}),
								Effect.timeout("5 seconds"),
							);
							expect(ended).toEqual([{ run: "completed", turn: "completed" }]);
							const calls = readFileSync(capture, "utf8")
								.trim()
								.split("\n")
								.map(
									(line) =>
										JSON.parse(line) as {
											kind: string;
											data?: { prompt?: string };
										},
								);
							return calls.filter(({ kind }) => kind === "send.options").at(-1)
								?.data?.prompt;
						});
					const first = yield* send(side.id, "Side question");
					expect(first).toBe(
						`${expectedDigest}\n\n[Current request]\nSide question`,
					);
					expect((yield* state.getState(side.id))["cursor.forkDigest"]).toBe(
						expectedDigest,
					);
					const second = yield* send(side.id, "Follow up");
					expect(second).toBe("Follow up");
					scenarios.push({
						scenario: "side-thread",
						creationProviderCalls,
						digestRowAtCreation: null,
						firstTurnDigest: first?.split("\n\n[Current request]\n")[0],
						expectedDigest,
						secondTurnDigest: null,
					});
					const forkDigest = renderForkDigest(
						yield* read.getSessionMessagesWithParts(fork.id),
					);
					const forkFirst = yield* send(fork.id, "Fork request");
					expect(forkFirst).toBe(
						`${forkDigest}\n\n[Current request]\nFork request`,
					);
					expect(yield* send(fork.id, "Fork follow up")).toBe("Fork follow up");
					scenarios.push({
						scenario: "fork",
						creationProviderCalls,
						digestRowAtCreation: null,
						firstTurnDigest: forkFirst?.split("\n\n[Current request]\n")[0],
						expectedDigest: forkDigest,
						secondTurnDigest: null,
					});
					for (const kind of ["non-fork", "empty-fork"] as const) {
						yield* commit([
							canonicalEvent("session.created", kind, {
								sessionId: kind,
								title: kind,
								provider: "cursor",
								...(kind === "empty-fork" ? { forkedFrom: "source" } : {}),
							}),
						]);
						const firstPrompt = yield* send(kind, "First");
						expect(firstPrompt).toBe("First");
						// A subsequent local message must never turn an empty fork into a seed.
						yield* commit([
							canonicalEvent("message.created", kind, {
								sessionId: kind,
								messageId: `${kind}:local`,
								role: "user",
							}),
						]);
						expect(yield* send(kind, "Second")).toBe("Second");
						expect(
							(yield* state.getState(kind))["cursor.forkDigest"],
						).toBeUndefined();
						scenarios.push({
							scenario: kind,
							creationProviderCalls: [],
							digestRowAtCreation: null,
							firstTurnDigest: null,
							secondTurnDigest: null,
						});
					}
				}).pipe(
					Effect.provide(SessionWorkspaceLive),
					Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Effect.provideService(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({}),
					),
					Effect.provideService(
						OrchestrationEngineTag,
						withDispatchEffect({ dispatchEffect: discover }),
					),
					Effect.provideService(
						AccountDirectory,
						makeMockAccountDirectory([account]),
					),
					Effect.provideService(
						ConfigTag,
						makeMockConfig({ projectDir: root, configDir: root }),
					),
					Effect.provideService(LoggerTag, makeMockLogger()),
					Effect.provide(makeOverridesStateLive()),
					Effect.provide(
						Layer.merge(
							persistence,
							ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
						),
					),
				),
			),
		);
	} finally {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-hiuf.7-flow.json",
			`${JSON.stringify({ ticket: "conduit-test-hiuf.7", scenarios }, null, 2)}\n`,
		);
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
