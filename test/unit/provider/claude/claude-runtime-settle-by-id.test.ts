// One SDK result can answer several inputs: the CLI folds a queued input into
// the running turn and names every input it consumed in user_message_uuids.
// The adapter settles them by id: the latest started owns the result, the
// rest resolve `joined`, which ProviderTurnService finalises as nothing. So a
// two-input result yields one completed turn and one `done`.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
	Query,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type {
	EventSink,
	TurnResult,
} from "../../../../src/lib/provider/types.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import { addClaudeRuntimeTurnWaiterForTest } from "../../../helpers/claude-runtime-state.js";
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

it("settles a result covering two inputs as one completed turn and one joined input", async () => {
	let foldIn = () => {};
	const folded = new Promise<void>((resolve) => {
		foldIn = resolve;
	});
	const gen = (async function* () {
		yield lifecycle(A, "queued");
		yield lifecycle(A, "started");
		yield messageStart("msg_A");
		await folded;
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
	})();
	const instance = makeTestClaudeProviderInstance({
		workspaceRoot: workspace,
		queryFactory: vi.fn(() => queryFrom(gen)),
	});
	const sink = createMockEventSink();

	const turnA = Effect.runPromise(
		instance.sendTurnEffect(
			makeBaseSendTurnInput({
				sessionId: "s-fold",
				inputId: A,
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
	// Ticket .7 hands a steer to the running query; register B as that would.
	const turnB = Effect.runSync(Deferred.make<TurnResult, Error>());
	addClaudeRuntimeTurnWaiterForTest(instance, "s-fold", B, turnB);
	foldIn();

	expect((await turnA).status).toBe("joined");
	const owner = await Effect.runPromise(Deferred.await(turnB));
	expect(owner).toMatchObject({ status: "completed", cost: 0.05 });

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
