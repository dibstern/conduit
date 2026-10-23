// One SDK result can answer several inputs: the CLI folds a queued input into
// the running turn and names every input it consumed in user_message_uuids.
// Each send acknowledges intake, while the shared native result streams one
// terminal event for the accepted run.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
	Query,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { ProviderInstanceFailure } from "../../../../src/lib/provider/errors.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const frame = (message: Record<string, unknown>) =>
	({
		session_id: "sdk-1",
		uuid: crypto.randomUUID(),
		...message,
	}) as SDKMessage;
const lifecycle = (input: string, state: string) =>
	frame({ type: "command_lifecycle", command_uuid: input, state });
const messageStart = (id: string) =>
	frame({
		type: "stream_event",
		parent_tool_use_id: null,
		event: { type: "message_start", message: { id } },
	});

function queryFrom(gen: AsyncGenerator<SDKMessage, void>): Query {
	const noop = vi.fn(async () => {});
	return Object.assign(gen, {
		interrupt: noop,
		close: vi.fn(),
		setModel: noop,
		setPermissionMode: noop,
		applyFlagSettings: noop,
		[Symbol.asyncIterator]: () => gen,
	}) as unknown as Query;
}

const pushed = (sink: EventSink) =>
	(
		sink.push as unknown as {
			mock: { calls: [{ type: string; data: Record<string, unknown> }][] };
		}
	).mock.calls.map(([event]) => event);

let workspace: string;
beforeEach(() => {
	workspace = join(tmpdir(), `conduit-claude-settle-${Date.now()}`);
	mkdirSync(workspace, { recursive: true });
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

it("rejects pending intake when the accepted native query ends before starting it", async () => {
	const end = Effect.runSync(Deferred.make<void>());
	const errors: unknown[] = [];
	const replies: string[] = [];
	let firstResultConsumed = false;
	const instance = makeTestClaudeProviderInstance({
		queryFactory: ({ prompt }) => {
			if (typeof prompt === "string")
				throw new Error("Expected streaming input");
			const inputs = prompt[Symbol.asyncIterator]();
			return queryFrom(
				(async function* () {
					await inputs.next();
					yield lifecycle(A, "started");
					await inputs.next();
					yield lifecycle(B, "queued");
					yield makeSuccessResult({ session_id: "sdk-1" });
					firstResultConsumed = true;
					await Effect.runPromise(Deferred.await(end));
				})(),
			);
		},
	});
	const send = (inputId: string, runId: string) =>
		Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s-queued-eof",
					inputId,
					runId,
					workspaceRoot: workspace,
					model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
				}),
			),
		);
	expect((await send(A, "run-a")).status).toBe("accepted");
	const second = send(B, "run-b")
		.then((reply) => {
			replies.push(reply.status);
		})
		.catch((error: unknown) => {
			errors.push(error);
		});
	try {
		await vi.waitFor(() => expect(firstResultConsumed).toBe(true));
		expect(replies).toEqual([]);
		Effect.runSync(Deferred.succeed(end, undefined));
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(errors[0]).toBeInstanceOf(ProviderInstanceFailure);
		expect(errors[0]).toMatchObject({
			message: expect.stringContaining("SDK stream ended without result"),
		});
		expect(replies).toEqual([]);
	} finally {
		Effect.runSync(Deferred.succeed(end, undefined));
		await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
		await second;
	}
});

it("preserves the native failure for an unstarted steer after an accepted input fails", async () => {
	const fail = Effect.runSync(Deferred.make<void>());
	const errors: unknown[] = [];
	const placed: string[] = [];
	let queued = false;
	const sink = createMockEventSink();
	const instance = makeTestClaudeProviderInstance({
		persistUserMessage: (_sessionId, _text, options) =>
			Effect.sync(() => {
				if (options?.inputId) placed.push(options.inputId);
			}),
		queryFactory: ({ prompt }) => {
			if (typeof prompt === "string")
				throw new Error("Expected streaming input");
			const inputs = prompt[Symbol.asyncIterator]();
			return queryFrom(
				(async function* () {
					await inputs.next();
					yield lifecycle(A, "started");
					yield messageStart("msg_A");
					await inputs.next();
					yield lifecycle(B, "queued");
					queued = true;
					await Effect.runPromise(Deferred.await(fail));
					throw new Error("Harness adapter failure");
				})(),
			);
		},
	});
	const send = (inputId: string, runId: string) =>
		Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s-queued-failure",
					inputId,
					runId,
					eventSink: sink,
					workspaceRoot: workspace,
					model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
				}),
			),
		);
	expect((await send(A, "run-a")).status).toBe("accepted");
	const second = send(B, "run-b").catch((error: unknown) => {
		errors.push(error);
	});
	try {
		await vi.waitFor(() => expect(queued).toBe(true));
		expect(errors).toEqual([]);
		expect(placed.filter((id) => id === B)).toEqual([]);
		Effect.runSync(Deferred.succeed(fail, undefined));
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		const events = vi.mocked(sink.push).mock.calls.map(([event]) => event);
		expect(events.filter((event) => event.type === "turn.error")).toEqual([
			expect.objectContaining({
				runId: "run-a",
				data: expect.objectContaining({ error: "Harness adapter failure" }),
			}),
		]);
		expect(
			events
				.filter((event) => event.type === "run.started")
				.map((event) => event.runId),
		).toEqual(["run-a"]);
		expect(placed.filter((id) => id === B)).toEqual([]);
		expect(errors[0]).toBeInstanceOf(ProviderInstanceFailure);
		expect(errors[0]).toMatchObject({
			message: expect.stringContaining("Harness adapter failure"),
		});
	} finally {
		Effect.runSync(Deferred.succeed(fail, undefined));
		await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
		await second;
	}
});

it("keeps queued intake pending when the prior accepted result omits input uuids", async () => {
	const startB = Effect.runSync(Deferred.make<void>());
	const finishB = Effect.runSync(Deferred.make<void>());
	const placed: string[] = [];
	const replies: string[] = [];
	let firstResultConsumed = false;
	const sink = createMockEventSink();
	const instance = makeTestClaudeProviderInstance({
		persistUserMessage: (_sessionId, _text, options) =>
			Effect.sync(() => {
				if (options?.inputId) placed.push(options.inputId);
			}),
		queryFactory: ({ prompt }) => {
			if (typeof prompt === "string")
				throw new Error("Expected streaming input");
			const inputs = prompt[Symbol.asyncIterator]();
			return queryFrom(
				(async function* () {
					await inputs.next();
					yield lifecycle(A, "started");
					yield messageStart("msg_A");
					await inputs.next();
					yield lifecycle(B, "queued");
					yield makeSuccessResult({ session_id: "sdk-1" });
					firstResultConsumed = true;
					await Effect.runPromise(Deferred.await(startB));
					yield lifecycle(B, "started");
					yield messageStart("msg_B");
					await Effect.runPromise(Deferred.await(finishB));
					yield makeSuccessResult({
						session_id: "sdk-1",
						user_message_uuid: B,
					});
				})(),
			);
		},
	});
	const send = (inputId: string, runId: string) =>
		Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s-uuidless",
					inputId,
					runId,
					eventSink: sink,
					workspaceRoot: workspace,
					model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
				}),
			),
		);
	expect((await send(A, "run-a")).status).toBe("accepted");
	const second = send(B, "run-b").then((reply) => {
		replies.push(reply.status);
	});
	try {
		await vi.waitFor(() => expect(firstResultConsumed).toBe(true));
		expect(replies).toEqual([]);
		expect(placed.filter((id) => id === B)).toEqual([]);
		Effect.runSync(Deferred.succeed(startB, undefined));
		await vi.waitFor(() => expect(replies).toEqual(["accepted"]));
		expect(placed.filter((id) => id === B)).toEqual([B]);
		expect(
			pushed(sink)
				.filter((event) => event.type === "run.started")
				.map((event) => event.data),
		).toEqual([
			{ inputId: A, requestedRunId: "run-a" },
			{ inputId: B, requestedRunId: "run-b" },
		]);
		expect(
			vi
				.mocked(sink.push)
				.mock.calls.map(([event]) => event)
				.filter((event) => event.type === "run.started")
				.map((event) => event.runId),
		).toEqual(["run-a", "run-b"]);
		Effect.runSync(Deferred.succeed(finishB, undefined));
		await vi.waitFor(() =>
			expect(
				pushed(sink).filter((event) => event.type === "turn.completed"),
			).toHaveLength(2),
		);
		expect(
			vi
				.mocked(sink.push)
				.mock.calls.map(([event]) => event)
				.filter((event) => event.type === "turn.completed")
				.map((event) => event.runId),
		).toEqual(["run-a", "run-b"]);
	} finally {
		Effect.runSync(Deferred.succeed(startB, undefined));
		Effect.runSync(Deferred.succeed(finishB, undefined));
		await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
		await second.catch(() => undefined);
	}
});

it("acknowledges two accepted inputs and streams their shared result once", async () => {
	const instance = makeTestClaudeProviderInstance({
		queryFactory: ({ prompt }) => {
			if (typeof prompt === "string")
				throw new Error("Expected streaming input");
			const inputs = prompt[Symbol.asyncIterator]();
			return queryFrom(
				(async function* () {
					await inputs.next();
					yield lifecycle(A, "queued");
					yield lifecycle(A, "started");
					yield messageStart("msg_A");
					await inputs.next();
					yield lifecycle(B, "queued");
					yield lifecycle(B, "started");
					yield messageStart("msg_B");
					yield makeSuccessResult({
						session_id: "sdk-1",
						user_message_uuid: B,
						user_message_uuids: [A, B],
					});
					yield lifecycle(B, "completed");
					yield lifecycle(A, "completed");
				})(),
			);
		},
	});
	const sink = createMockEventSink();

	const turnA = Effect.runPromise(
		instance.sendTurnEffect(
			makeBaseSendTurnInput({
				sessionId: "s-fold",
				inputId: A,
				runId: "run-a",
				eventSink: sink,
				workspaceRoot: workspace,
				model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
			}),
		),
	);
	await vi.waitFor(() =>
		expect(pushed(sink).map((event) => event.type)).toContain(
			"message.created",
		),
	);
	expect((await turnA).status).toBe("accepted");
	const turnB = await Effect.runPromise(
		instance.sendTurnEffect(
			makeBaseSendTurnInput({
				sessionId: "s-fold",
				inputId: B,
				runId: "run-b",
				eventSink: sink,
				workspaceRoot: workspace,
				model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
			}),
		),
	);
	expect(turnB.status).toBe("accepted");
	await vi.waitFor(() =>
		expect(
			pushed(sink).filter((event) => event.type === "turn.completed"),
		).toHaveLength(1),
	);

	const events = pushed(sink);
	expect(
		events.filter((event) => event.type === "turn.completed"),
	).toHaveLength(1);
	// B's start opens a new assistant message rather than extending A's.
	expect(
		events
			.filter((event) => event.type === "message.created")
			.map((event) => event.data["messageId"]),
	).toEqual(["msg_A", "msg_B"]);
});
