// The E2E Claude lane replays committed SDK traces through the runtime's
// injected queryFactory. A replay that silently drifts from its plan is worse
// than none, so every mode below must fail LOUDLY:
//
// 1. Undecodable trace: a planned trace line that fails ClaudeSDKMessageSchema
//    (or a trace name with no fixture) throws when the replayer is created,
//    before any relay starts.
// 2. Too many turns: a prompt beyond the plan throws into the SDK stream AND
//    makes assertComplete() throw.
// 3. Too few turns: assertComplete() throws when planned turns were never sent.
// 4. Dedupe loss: replaying one trace N times must yield N distinct sets of
//    SDK ids (uuid, assistant message.id, message_start message.id; the
//    translator dedupes on those, so reused ids would drop whole turns).
//    Only envelope ids change — content is byte-identical.
// 5. Unreplayed SDK surface: a Query method the replayer does not model
//    rejects instead of resolving to a plausible fake.
//
// Also pinned: per-message delay, and interrupt() ending the current trace.
// Fresh database per run is the harness's job (mkdtemp configDir per test).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	SDKMessage,
	SDKUserMessage,
} from "../../../src/lib/provider/claude/types.js";
import {
	type ClaudeTraceName,
	createClaudeTraceReplayer,
} from "../../e2e/helpers/claude-trace-replayer.js";

const TRACES_DIR = join(
	import.meta.dirname,
	"../../fixtures/claude-sdk-traces",
);

function userPrompt(text: string): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
	};
}

/** Prompt stream the test pushes into, like the runtime's prompt queue. */
function promptQueue() {
	const pending: SDKUserMessage[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const iterable: AsyncIterable<SDKUserMessage> = {
		async *[Symbol.asyncIterator]() {
			while (true) {
				const next = pending.shift();
				if (next) {
					yield next;
					continue;
				}
				if (closed) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
	return {
		iterable,
		push(text: string) {
			pending.push(userPrompt(text));
			wake?.();
		},
		close() {
			closed = true;
			wake?.();
		},
	};
}

async function readTurn(
	iterator: AsyncIterator<SDKMessage, void>,
): Promise<SDKMessage[]> {
	const messages: SDKMessage[] = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) return messages;
		messages.push(next.value);
		if (next.value.type === "result") return messages;
	}
}

function envelopeIds(messages: readonly SDKMessage[]): string[] {
	return messages.flatMap((message) => {
		const ids = [message.uuid ?? "", message.session_id ?? ""];
		if (message.type === "assistant") ids.push(message.message.id);
		if (
			message.type === "stream_event" &&
			message.event.type === "message_start"
		) {
			ids.push(message.event.message.id);
		}
		return ids;
	});
}

function traceLineCount(name: ClaudeTraceName): number {
	return readFileSync(join(TRACES_DIR, `${name}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "").length;
}

describe("createClaudeTraceReplayer", () => {
	it("plays one planned trace per prompt, in plan order", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn", "subagent-task-turn"],
		});
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		prompts.push("first");
		const first = await readTurn(iterator);
		prompts.push("second");
		const second = await readTurn(iterator);
		prompts.close();

		expect(first).toHaveLength(traceLineCount("pong-thinking-text-turn"));
		expect(second).toHaveLength(traceLineCount("subagent-task-turn"));
		expect(first.at(-1)).toMatchObject({ type: "result", result: "pong" });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
		replayer.assertComplete();
	});

	// Failure 4.
	it("rewrites envelope ids per replayed turn and leaves content alone", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: [
				"pong-thinking-text-turn",
				"pong-thinking-text-turn",
				"pong-thinking-text-turn",
			],
		});
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		const turns: SDKMessage[][] = [];
		for (const text of ["one", "two", "three"]) {
			prompts.push(text);
			turns.push(await readTurn(iterator));
		}

		// Every uuid and message id is unique across turns. session_id stays
		// stable across turns of one session, like the SDK's, but is not the
		// captured one (that could resolve a real transcript on this machine).
		const sessionId = turns[0]?.[0]?.session_id;
		expect(sessionId).not.toBe("6198d280-a44f-49f4-a2ad-cb1af4102adf");
		const perTurn = turns.map(
			(turn) =>
				new Set(
					envelopeIds(turn).filter((id) => id !== "" && id !== sessionId),
				),
		);
		const all = perTurn.flatMap((ids) => [...ids]);
		expect(new Set(all).size).toBe(all.length);
		expect(perTurn[0]?.size).toBeGreaterThan(
			traceLineCount("pong-thinking-text-turn"),
		);

		const withoutIds = (turn: SDKMessage[]) => {
			let json = JSON.stringify(turn);
			for (const id of envelopeIds(turn)) json = json.replaceAll(id, "<id>");
			return json;
		};
		expect(withoutIds(turns[1] ?? [])).toBe(withoutIds(turns[0] ?? []));
		expect(withoutIds(turns[2] ?? [])).toBe(withoutIds(turns[0] ?? []));
	});

	// Failure 1.
	it("throws at creation when a planned trace does not decode", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-trace-replayer-"));
		writeFileSync(
			join(dir, "pong-thinking-text-turn.jsonl"),
			`${JSON.stringify({ type: "assistant", uuid: "u1" })}\n`,
		);
		expect(() =>
			createClaudeTraceReplayer({
				turns: ["pong-thinking-text-turn"],
				tracesDir: dir,
			}),
		).toThrow(/pong-thinking-text-turn\.jsonl:1/);
		expect(() =>
			createClaudeTraceReplayer({
				turns: ["pong-thinking-text-turn"],
				tracesDir: join(dir, "missing"),
			}),
		).toThrow();
	});

	// Failure 2.
	it("fails the stream and assertComplete on an unplanned turn", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn"],
		});
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		prompts.push("planned");
		await readTurn(iterator);
		prompts.push("unplanned");

		await expect(iterator.next()).rejects.toThrow(/turn 2.*only 1 planned/);
		expect(() => replayer.assertComplete()).toThrow(/turn 2.*only 1 planned/);
	});

	// Failure 3.
	it("fails assertComplete when planned turns were never sent", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
		});
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		prompts.push("only one");
		await readTurn(iterator);

		expect(() => replayer.assertComplete()).toThrow(/played 1 of 2/);
	});

	// Failure 5.
	it("rejects Query methods it does not replay", async () => {
		const replayer = createClaudeTraceReplayer({ turns: [] });
		const query = replayer.sdk.query({
			prompt: promptQueue().iterable,
		});

		await expect(query.supportedModels()).rejects.toThrow(
			/supportedModels is not replayed/,
		);
		await expect(query.setModel("claude-fable-5")).resolves.toBeUndefined();
	});

	it("delays every message by delayMs", async () => {
		const delayMs = 10;
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn"],
			delayMs,
		});
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		const started = performance.now();
		prompts.push("slow");
		const turn = await readTurn(iterator);

		expect(performance.now() - started).toBeGreaterThanOrEqual(
			turn.length * delayMs * 0.9,
		);
	});

	it("interrupt() ends the current trace; the next prompt plays the next turn", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
		});
		const prompts = promptQueue();
		const query = replayer.sdk.query({ prompt: prompts.iterable });
		const iterator = query[Symbol.asyncIterator]();

		prompts.push("interrupted");
		const first = await iterator.next();
		expect(first.done).toBe(false);
		await query.interrupt();
		prompts.push("next");
		const next = await readTurn(iterator);

		expect(next).toHaveLength(traceLineCount("pong-thinking-text-turn"));
		replayer.assertComplete();
	});
});
