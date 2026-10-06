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
// 6. Fork identity: each fork must have a fresh resumable SDK id; resuming it
//    must not emit its parent's id or accept an unknown session.
// 7. Fork cut drift: readTranscript must list what was actually replayed in
//    that session (each prompt, then its main-chain SDK messages with their
//    fresh ids), or conduit's fork-point lookup misses and falls back. A fork
//    with upToMessageId must copy through exactly that entry (inclusive, as
//    the SDK does) and reject a uuid the parent never had.
// 8. Mid-turn hold: holdTurnBeforeToolResult must stop exactly that sent turn
//    after its tool_use and before its first tool_result, keep other
//    sessions' turns playing, and let the held turn finish only after
//    release().
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

	// Failure 6.
	it("replays captured fork operations and resumes the fork with its own id", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: [
				"pong-thinking-text-turn",
				"pong-thinking-text-turn",
				"pong-thinking-text-turn",
			],
		});
		const prompts = promptQueue();
		const parent = replayer.sdk.query({
			prompt: prompts.iterable,
			options: { resume: "restored-parent" },
		});
		prompts.push("parent");
		const first = await readTurn(parent);
		const parentId = first.at(-1)?.session_id;
		if (!parentId) throw new Error("Replay returned no SDK session id");
		const captured = JSON.parse(
			readFileSync(join(TRACES_DIR, "fork-session.json"), "utf8"),
		) as { parentSessionId: string; forkSession: { sessionId: string } };
		const transcript = await replayer.sdk.fork.readTranscript(parentId, {
			dir: "/replay",
		});
		expect(transcript.some((entry) => entry.type === "user")).toBe(true);
		expect(transcript.some((entry) => entry.type === "assistant")).toBe(true);
		expect(JSON.stringify(transcript)).toContain(parentId);
		expect(JSON.stringify(transcript)).not.toContain(captured.parentSessionId);

		const fork = await replayer.sdk.fork.forkSession(parentId, {
			dir: "/replay",
			title: "Fork",
		});
		const sibling = await replayer.sdk.fork.forkSession(parentId, {
			dir: "/replay",
			title: "Another fork",
		});
		expect(new Set([parentId, fork.sessionId, sibling.sessionId]).size).toBe(3);
		expect(fork.sessionId).not.toBe(captured.forkSession.sessionId);
		const forkPrompts = promptQueue();
		const resumed = replayer.sdk.query({
			prompt: forkPrompts.iterable,
			options: { resume: fork.sessionId },
		});
		forkPrompts.push("fork turn");
		const forkTurn = await readTurn(resumed);
		expect(forkTurn.at(-1)).toMatchObject({
			type: "result",
			result: "pong",
			session_id: fork.sessionId,
		});
		expect(
			forkTurn.every((message) => message.session_id === fork.sessionId),
		).toBe(true);
		prompts.push("parent again");
		expect((await readTurn(parent)).at(-1)?.session_id).toBe(parentId);
		prompts.close();
		forkPrompts.close();
		parent.close();
		resumed.close();
		replayer.assertComplete();
	});

	it("rejects forks, transcript reads and resumes of unknown sessions", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn"],
		});
		const prompts = promptQueue();
		const query = replayer.sdk.query({ prompt: prompts.iterable });
		prompts.push("parent");
		await readTurn(query);
		prompts.close();
		query.close();
		await expect(
			replayer.sdk.fork.readTranscript("unknown", { dir: "/replay" }),
		).rejects.toThrow(/unknown session/);
		await expect(
			replayer.sdk.fork.forkSession("unknown", {
				dir: "/replay",
				title: "Fork",
			}),
		).rejects.toThrow(/unknown session/);
		expect(() =>
			replayer.sdk.query({
				prompt: promptQueue().iterable,
				options: { resume: "unknown" },
			}),
		).toThrow(/unknown session/);
		replayer.assertComplete();
	});

	// Failure 7.
	it("lists the replayed transcript and forks through upToMessageId inclusive", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
		});
		const prompts = promptQueue();
		const parent = replayer.sdk.query({ prompt: prompts.iterable });
		prompts.push("first");
		const first = await readTurn(parent);
		prompts.push("second");
		const second = await readTurn(parent);
		const parentId = first.at(-1)?.session_id;
		if (!parentId) throw new Error("Replay returned no SDK session id");
		const transcript = await replayer.sdk.fork.readTranscript(parentId, {
			dir: "/replay",
		});
		const promptAt = (text: string) =>
			transcript.findIndex(
				(entry) =>
					entry.type === "user" &&
					JSON.stringify(entry.message) ===
						JSON.stringify({ role: "user", content: text }),
			);
		expect(promptAt("first")).toBe(0);
		expect(
			transcript.flatMap((entry) =>
				entry.type === "assistant" ? [entry.message] : [],
			),
		).toEqual(
			[...first, ...second].flatMap((message) =>
				message.type === "assistant" ? [message.message] : [],
			),
		);
		const cut = transcript[promptAt("second") - 1]?.uuid;
		if (!cut) throw new Error("First turn left no transcript entry");

		const fork = await replayer.sdk.fork.forkSession(parentId, {
			dir: "/replay",
			title: "Fork",
			upToMessageId: cut,
		});
		expect(
			await replayer.sdk.fork.readTranscript(fork.sessionId, {
				dir: "/replay",
			}),
		).toEqual(
			transcript
				.slice(0, promptAt("second"))
				.map((entry) => ({ ...entry, session_id: fork.sessionId })),
		);
		expect(replayer.forks).toEqual([
			{
				parentSessionId: parentId,
				sessionId: fork.sessionId,
				upToMessageId: cut,
			},
		]);
		await expect(
			replayer.sdk.fork.forkSession(parentId, {
				dir: "/replay",
				title: "Fork",
				upToMessageId: "never-replayed",
			}),
		).rejects.toThrow(/never-replayed is not in session/);
		expect(replayer.forks).toHaveLength(1);
		prompts.close();
		parent.close();
		replayer.assertComplete();
	});

	// Failure 8.
	it("holds the planned turn before its first tool_result until release()", async () => {
		const replayer = createClaudeTraceReplayer({
			turns: ["extra-folder-read-turn", "pong-thinking-text-turn"],
			holdTurnBeforeToolResult: 1,
		});
		const prompts = promptQueue();
		const parent = replayer.sdk.query({ prompt: prompts.iterable });
		const parentTurn = parent[Symbol.asyncIterator]();
		prompts.push("read");
		const beforeHold: SDKMessage[] = [];
		let resumed = parentTurn.next();
		while (true) {
			const next = await Promise.race([
				resumed,
				new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
			]);
			if (next === undefined) break;
			if (next.done) throw new Error("Turn ended without a hold");
			beforeHold.push(next.value);
			resumed = parentTurn.next();
		}
		expect(
			beforeHold.some(
				(message) =>
					message.type === "assistant" &&
					message.message.content.some((block) => block.type === "tool_use"),
			),
		).toBe(true);
		expect(beforeHold.some((message) => message.type === "user")).toBe(false);

		const parentId = beforeHold[0]?.session_id;
		if (!parentId) throw new Error("Replay returned no SDK session id");
		const fork = await replayer.sdk.fork.forkSession(parentId, {
			dir: "/replay",
			title: "Fork",
		});
		const forkPrompts = promptQueue();
		const side = replayer.sdk.query({
			prompt: forkPrompts.iterable,
			options: { resume: fork.sessionId },
		});
		forkPrompts.push("side");
		expect((await readTurn(side)).at(-1)).toMatchObject({
			type: "result",
			result: "pong",
		});

		replayer.release();
		const next = await resumed;
		if (next.done) throw new Error("Held turn ended without its messages");
		expect(next.value.type).toBe("user");
		const rest = [next.value, ...(await readTurn(parentTurn))];
		expect(rest.at(-1)?.type).toBe("result");
		expect(beforeHold.length + rest.length).toBe(
			traceLineCount("extra-folder-read-turn"),
		);
		prompts.close();
		forkPrompts.close();
		parent.close();
		side.close();
		replayer.assertComplete();
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
