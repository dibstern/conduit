import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberRef,
	Layer,
	ManagedRuntime,
	Option,
	Stream,
} from "effect";
import { afterEach, expect, it } from "vitest";
import { BUILD_ID } from "../../../../src/lib/build-id.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { connectClaudeRunner } from "../../../../src/lib/provider/claude/claude-runner-connection.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	type ClaudeRunnerMessage,
	ClaudeRunnerSocket,
	claudeRunnerFailure,
} from "../../../../src/lib/provider/claude/claude-runner-protocol.js";
import {
	type ClaudeRunnerOutputReceipt,
	currentClaudeRunnerOutput,
	makeClaudeRunnerReceiptStore,
} from "../../../../src/lib/provider/claude/claude-runner-receipts.js";
import { ClaudeRunnerSpool } from "../../../../src/lib/provider/claude/claude-runner-spool.js";
import { claudeRuntimeEvent } from "../../../../src/lib/provider/claude/claude-runtime-event.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
} from "../../../../src/lib/provider/claude/claude-session-runner.js";
import { createRelayEventSink } from "../../../../src/lib/provider/relay-event-sink.js";
import type { PermissionResponse } from "../../../../src/lib/provider/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const eventOutput = (id: string): ClaudeSessionOutput => ({
	type: "event",
	sinkId: "sink",
	event: claudeRuntimeEvent("message.created", "session", {
		sessionId: "session",
		messageId: id,
		role: "assistant",
	}),
});

const terminalOutput = (id: string): ClaudeSessionOutput => ({
	type: "event",
	sinkId: "sink",
	event: claudeRuntimeEvent("turn.completed", "session", { messageId: id }),
});

async function fixture(beforePublish: Effect.Effect<void> = Effect.void) {
	const directory = mkdtempSync(join(tmpdir(), "conduit-runner-race-"));
	const published: unknown[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: (events) =>
			beforePublish.pipe(
				Effect.zipRight(Effect.sync(() => void published.push(...events))),
			),
		publishAdvance: () => Effect.void,
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
	const runtime = ManagedRuntime.make(
		makeProviderRuntimeIngestionLive().pipe(
			Layer.provideMerge(
				Layer.merge(
					makePersistenceEffectLayer(
						join(directory, "events.db"),
						undefined,
						bus,
					),
					bus,
				),
			),
		),
	);
	const sql = await runtime.runPromise(SqlClient.SqlClient);
	const ingestion = await runtime.runPromise(ProviderRuntimeIngestionTag);
	const receipts = await runtime.runPromise(makeClaudeRunnerReceiptStore(sql));
	const peers: ClaudeRunnerSocket[] = [];
	const closedPeers = new Set<ClaudeRunnerSocket>();
	const frames: ClaudeRunnerMessage[] = [];
	let closing = false;
	const fibers: Fiber.RuntimeFiber<void, unknown>[] = [];
	const spool = new ClaudeRunnerSpool(join(directory, "runner.spool"));
	const socketPath = join(directory, "runner.sock");
	const server = createServer((socket) => {
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => {
				frames.push(message);
				if (message.type === "hello")
					peer.write({
						type: "hello",
						protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION,
						buildId: BUILD_ID,
						runnerId: "runner",
						sessionId: "session",
					});
				else if (message.type === "replay")
					spool.attach(peer, message.acknowledgedSequence);
				else if (message.type === "output-reply") spool.reply(message);
			},
			() => {
				closedPeers.add(peer);
				if (!closing) spool.disconnect(peer);
			},
		);
		peers.push(peer);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	cleanups.push(async () => {
		closing = true;
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await runtime.runPromise(Effect.forEach(fibers, Fiber.interrupt));
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
	const ingest = (output: ClaudeSessionOutput) =>
		output.type === "event"
			? ingestion.ingest(output.event).pipe(
					Effect.as({} satisfies ClaudeSessionOutputReply),
					Effect.mapError((cause) => claudeRunnerFailure("ingest", cause)),
				)
			: Effect.succeed({});
	const attach = (
		emit: (
			output: ClaudeSessionOutput,
		) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure> = ingest,
		restore: Effect.Effect<void, ClaudeSessionFailure> = Effect.void,
	) =>
		runtime.runPromise(
			connectClaudeRunner({
				socketPath,
				sessionId: "session",
				runnerId: "runner",
				deps: { workspaceRoot: directory },
				receipts,
				runFork: (effect) => fibers.push(runtime.runFork(effect)),
				emit,
				onHello: () => restore,
				onClose: () => {},
			}),
		);
	return {
		runtime,
		sql,
		ingestion,
		receipts,
		peers,
		closedPeers,
		frames,
		spool,
		attach,
		ingest,
		published,
	};
}

it("acknowledges a durable terminal output while its event publication is still pending", async () => {
	const publishing = await Effect.runPromise(Deferred.make<void>());
	const release = await Effect.runPromise(Deferred.make<void>());
	const f = await fixture(
		Deferred.succeed(publishing, undefined).pipe(
			Effect.zipRight(Deferred.await(release)),
		),
	);
	cleanups.push(async () => {
		await f.runtime.runPromise(Deferred.succeed(release, undefined));
	});
	await f.attach();
	await expect
		.poll(() => f.frames.some((frame) => frame.type === "replay"))
		.toBe(true);
	const emission = f.runtime.runFork(f.spool.emit(terminalOutput("terminal")));
	cleanups.push(async () => {
		await f.runtime.runPromise(Fiber.interrupt(emission));
	});
	await f.runtime.runPromise(
		Deferred.await(publishing).pipe(Effect.timeout("2 seconds")),
	);
	expect(await f.runtime.runPromise(f.receipts.read("runner"))).toMatchObject({
		sequence: 1,
	});
	expect(await f.runtime.runPromise(f.sql`SELECT type FROM events`)).toEqual([
		{ type: "turn.completed" },
	]);
	expect(f.published).toHaveLength(0);
	expect(
		Option.isSome(
			await f.runtime.runPromise(
				Fiber.join(emission).pipe(Effect.timeoutOption("100 millis")),
			),
		),
	).toBe(true);
	expect(f.frames.filter((frame) => frame.type === "output-reply")).toEqual([
		{ type: "output-reply", outputId: "1", sequence: 1, result: {} },
	]);
	await f.runtime.runPromise(Deferred.succeed(release, undefined));
	await expect.poll(() => f.published.length).toBe(1);
	await f.runtime.runPromise(
		f.spool.emit(eventOutput("next")).pipe(Effect.timeout("2 seconds")),
	);
	expect(
		f.frames.filter(
			(frame) => frame.type === "output-reply" && frame.sequence === 1,
		),
	).toHaveLength(1);
	expect(
		await f.runtime.runPromise(
			f.sql`SELECT type FROM events ORDER BY sequence`,
		),
	).toEqual([{ type: "turn.completed" }, { type: "message.created" }]);
	expect(f.published).toHaveLength(2);
});

it("fires durable callbacks only for a claimed terminal receipt, never a fenced or duplicate receipt", async () => {
	const f = await fixture();
	let callbacks = 0;
	const receipt: ClaudeRunnerOutputReceipt = {
		runnerId: "runner",
		sequence: 1,
		attachmentId: "old",
		committed: await f.runtime.runPromise(Deferred.make<void>()),
		consumed: false,
		onCommitted: () => {
			callbacks += 1;
		},
	};
	await f.runtime.runPromise(f.receipts.attach("runner", "old"));
	await f.runtime.runPromise(f.receipts.attach("runner", "replacement"));
	const output = terminalOutput("claimed");
	await f.runtime.runPromise(
		f.ingest(output).pipe(Effect.locally(currentClaudeRunnerOutput, receipt)),
	);
	expect(callbacks).toBe(0);
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(0);
	const replacement = {
		...receipt,
		attachmentId: "replacement",
		consumed: false,
		committed: await f.runtime.runPromise(Deferred.make<void>()),
	};
	await f.runtime.runPromise(
		f
			.ingest(output)
			.pipe(Effect.locally(currentClaudeRunnerOutput, replacement)),
	);
	expect(callbacks).toBe(1);
	await f.runtime.runPromise(
		f.ingest(output).pipe(
			Effect.locally(currentClaudeRunnerOutput, {
				...replacement,
				consumed: false,
				committed: await f.runtime.runPromise(Deferred.make<void>()),
			}),
		),
	);
	expect(callbacks).toBe(1);
	expect(f.published).toHaveLength(1);
});

it("does not acknowledge a rolled-back terminal transaction before its successful retry commits", async () => {
	const publishing = await Effect.runPromise(Deferred.make<void>());
	const releasePublication = await Effect.runPromise(Deferred.make<void>());
	const retry = await Effect.runPromise(Deferred.make<void>());
	const releaseRetry = await Effect.runPromise(Deferred.make<void>());
	const f = await fixture(
		Deferred.succeed(publishing, undefined).pipe(
			Effect.zipRight(Deferred.await(releasePublication)),
		),
	);
	cleanups.push(async () => {
		await f.runtime.runPromise(Deferred.succeed(releaseRetry, undefined));
		await f.runtime.runPromise(Deferred.succeed(releasePublication, undefined));
	});
	let attempts = 0;
	await f.attach((output) =>
		Effect.gen(function* () {
			if (output.type !== "event") return {};
			attempts += 1;
			if (attempts > 1) {
				yield* Deferred.succeed(retry, undefined);
				yield* Deferred.await(releaseRetry);
			}
			yield* f.ingestion.ingestBatch([output.event], {
				beforeCommit:
					attempts === 1
						? f.sql`SELECT * FROM missing_terminal_transaction_table`.pipe(
								Effect.asVoid,
							)
						: Effect.void,
			});
			return {};
		}).pipe(Effect.mapError((cause) => claudeRunnerFailure("ingest", cause))),
	);
	await expect
		.poll(() => f.frames.some((frame) => frame.type === "replay"))
		.toBe(true);
	const emission = f.runtime.runFork(f.spool.emit(terminalOutput("retry")));
	cleanups.push(async () => {
		await f.runtime.runPromise(Fiber.interrupt(emission));
	});
	await f.runtime.runPromise(
		Deferred.await(retry).pipe(Effect.timeout("2 seconds")),
	);
	expect(
		f.frames.filter((frame) => frame.type === "output-reply"),
	).toHaveLength(0);
	expect(await f.runtime.runPromise(f.receipts.read("runner"))).toMatchObject({
		sequence: 0,
	});
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(0);
	await f.runtime.runPromise(Deferred.succeed(releaseRetry, undefined));
	await f.runtime.runPromise(
		Deferred.await(publishing).pipe(Effect.timeout("2 seconds")),
	);
	expect(
		Option.isSome(
			await f.runtime.runPromise(
				Fiber.join(emission).pipe(Effect.timeoutOption("100 millis")),
			),
		),
	).toBe(true);
	await f.runtime.runPromise(Deferred.succeed(releasePublication, undefined));
	await expect.poll(() => f.published.length).toBe(1);
	expect(
		f.frames.filter((frame) => frame.type === "output-reply"),
	).toHaveLength(1);
	expect(await f.runtime.runPromise(f.receipts.read("runner"))).toMatchObject({
		sequence: 1,
	});
	expect(attempts).toBe(2);
});

it("fences a disconnected attachment before its pending event can commit", async () => {
	const f = await fixture();
	const entered = await f.runtime.runPromise(Deferred.make<void>());
	const release = await f.runtime.runPromise(Deferred.make<void>());
	const staleFinished = await f.runtime.runPromise(Deferred.make<void>());
	const output = eventOutput("overlap");
	const first = await f.attach((event) =>
		Deferred.succeed(entered, undefined).pipe(
			Effect.zipRight(Deferred.await(release)),
			Effect.zipRight(f.ingest(event)),
			Effect.ensuring(Deferred.succeed(staleFinished, undefined)),
		),
	);
	f.peers[0]?.write({ type: "output", outputId: "1", sequence: 1, output });
	await f.runtime.runPromise(Deferred.await(entered));
	first.destroy();
	await expect
		.poll(() => f.peers[0] !== undefined && f.closedPeers.has(f.peers[0]))
		.toBe(true);
	await f.attach();
	await f.runtime.runPromise(Deferred.succeed(release, undefined));
	await f.runtime.runPromise(Deferred.await(staleFinished));
	expect(await f.runtime.runPromise(f.receipts.read("runner"))).toMatchObject({
		sequence: 0,
	});
	f.peers[1]?.write({ type: "output", outputId: "1", sequence: 1, output });
	await expect
		.poll(
			() => f.frames.filter((frame) => frame.type === "output-reply").length,
		)
		.toBe(1);
	expect(f.frames.find((frame) => frame.type === "output-reply")).toMatchObject(
		{ result: {}, sequence: 1 },
	);
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(1);
	expect(f.published).toHaveLength(1);
});

it("accepts a sequence already durably appended without publishing it twice", async () => {
	const f = await fixture();
	await f.runtime.runPromise(f.receipts.attach("runner", "direct"));
	const output = eventOutput("duplicate");
	const receipt = {
		runnerId: "runner",
		sequence: 1,
		attachmentId: "direct",
		committed: await f.runtime.runPromise(Deferred.make<void>()),
		consumed: false,
	};
	await f.runtime.runPromise(
		f.ingest(output).pipe(Effect.locally(currentClaudeRunnerOutput, receipt)),
	);
	const duplicate = {
		...receipt,
		consumed: false,
		committed: await f.runtime.runPromise(Deferred.make<void>()),
	};
	const result = await f.runtime.runPromiseExit(
		f.ingest(output).pipe(Effect.locally(currentClaudeRunnerOutput, duplicate)),
	);
	expect(Exit.isSuccess(result)).toBe(true);
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(1);
	expect(f.published).toHaveLength(1);
	expect(duplicate.consumed).toBe(true);
});

it("replays a retained frame after one transient ingestion failure and continues the session", async () => {
	const f = await fixture();
	let calls = 0;
	await f.attach((output) => {
		calls += 1;
		return calls === 1
			? Effect.fail(claudeRunnerFailure("ingest", "transient write failure"))
			: f.ingest(output);
	});
	await expect
		.poll(() => f.frames.some((frame) => frame.type === "replay"))
		.toBe(true);
	const first = await f.runtime.runPromiseExit(
		f.spool.emit(eventOutput("first")).pipe(Effect.timeout("2 seconds")),
	);
	expect(Exit.isSuccess(first)).toBe(true);
	const second = await f.runtime.runPromiseExit(
		f.spool.emit(eventOutput("second")).pipe(Effect.timeout("2 seconds")),
	);
	expect(Exit.isSuccess(second)).toBe(true);
	expect(calls).toBe(3);
	expect(await f.runtime.runPromise(f.receipts.read("runner"))).toMatchObject({
		sequence: 2,
	});
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(2);
	expect(f.published).toHaveLength(2);
});

it("keeps a replacement attachment's cached reply when a stale data request finishes", async () => {
	const f = await fixture();
	await f.runtime.runPromise(f.receipts.attach("runner", "old"));
	await f.runtime.runPromise(f.receipts.attach("runner", "replacement"));
	await f.runtime.runPromise(
		f.receipts.acknowledge("runner", 1, { history: [] }, "replacement"),
	);
	await f.runtime.runPromise(
		f.receipts.acknowledge("runner", 1, { children: [] }, "old"),
	);
	expect(await f.runtime.runPromise(f.receipts.replyAt("runner", 1))).toEqual({
		history: [],
	});
});

it("fences a pending approval's later resolution after its ask receipt was consumed", async () => {
	const f = await fixture();
	const response = await f.runtime.runPromise(
		Deferred.make<PermissionResponse>(),
	);
	const receipt = {
		runnerId: "runner",
		sequence: 1,
		attachmentId: "old",
		committed: await f.runtime.runPromise(Deferred.make<void>()),
		consumed: false,
	};
	await f.runtime.runPromise(f.receipts.attach("runner", "old"));
	const sink = createRelayEventSink({
		sessionId: "session",
		providerId: "claude",
		send: () => {},
		ingestion: f.ingestion,
		pendingInteractions: {
			beginPermissionRequest: () =>
				Effect.succeed({ awaitResponse: Deferred.await(response) }),
			resolvePermissionRequest: () => Effect.succeed(true),
			beginQuestionRequest: () => Effect.die("unused question request"),
			resolveQuestionRequest: () => Effect.succeed(true),
		},
	});
	const request = f.runtime.runFork(
		sink
			.requestPermission({
				requestId: "request",
				sessionId: "session",
				turnId: "turn",
				providerItemId: "tool",
				toolName: "Bash",
				toolInput: { command: "pwd" },
			})
			.pipe(Effect.locally(currentClaudeRunnerOutput, receipt)),
	);
	cleanups.push(async () => {
		await f.runtime.runPromise(Fiber.interrupt(request));
	});
	await f.runtime.runPromise(Deferred.await(receipt.committed));
	expect(receipt.consumed).toBe(true);
	await f.runtime.runPromise(f.receipts.attach("runner", "replacement"));
	await f.runtime.runPromise(Deferred.succeed(response, { decision: "once" }));
	await f.runtime.runPromise(Fiber.join(request));
	expect(
		await f.runtime.runPromise(
			f.sql`SELECT type FROM events ORDER BY sequence`,
		),
	).toEqual([{ type: "permission.asked" }]);
	expect(f.published).toHaveLength(1);
	expect(
		await f.runtime.runPromise(
			f.sql`SELECT * FROM claude_runner_permission_replies`,
		),
	).toHaveLength(0);
});

it("fences later events inherited from a previous hello restoration", async () => {
	const f = await fixture();
	let restored: ClaudeRunnerOutputReceipt | undefined;
	await f.attach(
		undefined,
		Effect.gen(function* () {
			restored = yield* FiberRef.get(currentClaudeRunnerOutput);
		}),
	);
	await f.attach();
	await f.runtime.runPromise(
		f
			.ingest(eventOutput("restored"))
			.pipe(Effect.locally(currentClaudeRunnerOutput, restored)),
	);
	expect(
		await f.runtime.runPromise(f.sql`SELECT event_id FROM events`),
	).toHaveLength(0);
	expect(f.published).toHaveLength(0);
});

it("migrates a legacy cursor while retaining its sequence and cached reply", async () => {
	const f = await fixture();
	await f.runtime.runPromise(f.sql`DROP TABLE claude_runner_cursors`);
	await f.runtime.runPromise(
		f.sql`CREATE TABLE claude_runner_cursors (runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, result_json TEXT NOT NULL DEFAULT '{}')`,
	);
	await f.runtime.runPromise(
		f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, result_json) VALUES ('runner', 7, '{"history":[]}')`,
	);
	const migrated = await f.runtime.runPromise(
		makeClaudeRunnerReceiptStore(f.sql),
	);
	expect(
		await f.runtime.runPromise(migrated.attach("runner", "replacement")),
	).toEqual({ sequence: 7, result: { history: [] } });
	expect(
		await f.runtime.runPromise(
			f.sql<{
				attachment_id: string;
			}>`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = 'runner'`,
		),
	).toEqual([{ attachment_id: "replacement" }]);
	await f.runtime.runPromise(migrated.acknowledge("runner", 8, {}, "stale"));
	expect(await f.runtime.runPromise(migrated.read("runner"))).toMatchObject({
		sequence: 7,
	});
});
