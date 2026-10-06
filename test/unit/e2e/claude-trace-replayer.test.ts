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
//
// A trace may record several inputs (command_uuid, user_message_uuid(s)): each
// sent prompt answers the next recorded input in plan order, and the replay
// holds before each later input's command_lifecycle queued frame until conduit
// pushes that prompt. That adds four modes:
//
// 6. Unmatched prompt: a prompt arrives that no recorded input matches (more
//    prompts than the plan's traces record inputs). It throws into the SDK
//    stream AND makes assertComplete() throw. Mode 2 is its one-input case.
// 7. Unsent input: a recorded input is never sent: the query closes while the
//    replay holds for it, or the test ends with it unconsumed. assertComplete()
//    names the trace and the input. Mode 3 is its one-input case.
// 8. Ids mapped out of order: a frame references a later recorded input before
//    that input's queued frame, i.e. before the prompt it maps to could have
//    been sent. The trace fails at creation, naming the line.
// 9. Unrecorded interrupt: interrupt() arrives during a trace that records
//    several inputs or an interrupt, and the trace has no further interrupt to
//    answer it with. interrupt() rejects AND assertComplete() throws. A
//    one-input trace with no recorded interrupt keeps the synthesized stop
//    (interrupt() drops the rest of the trace) that Stop scenarios rely on.
//
// Also pinned: per-message delay, interrupt() ending the current trace, and
// interrupt() answered with the receipt a trace records.
// Fresh database per run is the harness's job (mkdtemp configDir per test).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

function userPrompt(
	text: string,
	uuid?: SDKUserMessage["uuid"],
): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		...(uuid ? { uuid } : {}),
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
		push(text: string, uuid?: SDKUserMessage["uuid"]) {
			pending.push(userPrompt(text, uuid));
			wake?.();
		},
		close() {
			closed = true;
			wake?.();
		},
	};
}

// A turn can carry frames after its result (command_lifecycle completed), so
// read the planned trace's length, stopping early only if the stream ends.
async function readTurn(
	iterator: AsyncIterator<SDKMessage, void>,
	name: ClaudeTraceName = "pong-thinking-text-turn",
): Promise<SDKMessage[]> {
	const messages: SDKMessage[] = [];
	while (messages.length < traceLineCount(name)) {
		const next = await iterator.next();
		if (next.done) return messages;
		messages.push(next.value);
	}
	return messages;
}

function envelopeIds(messages: readonly SDKMessage[]): string[] {
	return messages.flatMap((message) => {
		const ids = [message.uuid ?? "", message.session_id ?? ""];
		if (message.type === "assistant") ids.push(message.message.id);
		if (message.type === "command_lifecycle") ids.push(message.command_uuid);
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

const TWO_INPUTS = "second-input-held-to-turn-end";
const SENT_A = "00000000-0000-4000-8000-00000000000a";
const SENT_B = "00000000-0000-4000-8000-00000000000b";
const SENT_C = "00000000-0000-4000-8000-00000000000c";

type Raw = Record<string, unknown>;

function traceJson(name: ClaudeTraceName): Raw[] {
	return readFileSync(join(TRACES_DIR, `${name}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Raw);
}

/** The trace's recorded input ids, in recorded order. */
function recordedInputs(lines: readonly Raw[]): string[] {
	return [
		...new Set(
			lines.flatMap((line) =>
				line["type"] === "command_lifecycle"
					? [String(line["command_uuid"])]
					: [],
			),
		),
	];
}

/** How many frames play before the first one naming `id`. */
function framesBefore(lines: readonly Raw[], id: string): number {
	return lines.findIndex((line) => JSON.stringify(line).includes(`"${id}"`));
}

async function read(
	iterator: AsyncIterator<SDKMessage, void>,
	count: number,
): Promise<SDKMessage[]> {
	const messages: SDKMessage[] = [];
	while (messages.length < count) {
		const next = await iterator.next();
		if (next.done) return messages;
		messages.push(next.value);
	}
	return messages;
}

const settlesWithin = (promise: Promise<unknown>, ms: number) =>
	Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

function writeTrace(lines: readonly Raw[]): string {
	const dir = mkdtempSync(join(tmpdir(), "claude-trace-replayer-"));
	writeFileSync(
		join(dir, `${TWO_INPUTS}.jsonl`),
		lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
	);
	return dir;
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
		const second = await readTurn(iterator, "subagent-task-turn");
		prompts.close();

		expect(first).toHaveLength(traceLineCount("pong-thinking-text-turn"));
		expect(second).toHaveLength(traceLineCount("subagent-task-turn"));
		expect(first.find((message) => message.type === "result")).toMatchObject({
			result: "pong",
		});
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
		expect(sessionId).not.toBe("cfc5d5a4-e87b-4ca1-a1d1-f9d73ff47324");
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
		expect(forkTurn.find((message) => message.type === "result")).toMatchObject(
			{
				type: "result",
				result: "pong",
				session_id: fork.sessionId,
			},
		);
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
		expect(
			(await readTurn(side)).find((message) => message.type === "result"),
		).toMatchObject({
			type: "result",
			result: "pong",
		});

		replayer.release();
		const next = await resumed;
		if (next.done) throw new Error("Held turn ended without its messages");
		expect(next.value.type).toBe("user");
		const rest = [next.value];
		while (rest.at(-1)?.type !== "result") {
			const more = await parentTurn.next();
			if (more.done) break;
			rest.push(more.value);
		}
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

		const unmatched = /prompt 2 was sent, but no recorded input matches it/;
		await expect(iterator.next()).rejects.toThrow(unmatched);
		expect(() => replayer.assertComplete()).toThrow(unmatched);
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

		expect(() => replayer.assertComplete()).toThrow(
			/recorded input 1 of trace 2 \(pong-thinking-text-turn\) was never sent \(1 of 2/,
		);
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
	it("holds a later input's queued frame until its prompt and maps recorded ids to sent ones", async () => {
		const lines = traceJson(TWO_INPUTS);
		const [recordedA = "", recordedB = ""] = recordedInputs(lines);
		const replayer = createClaudeTraceReplayer({ turns: [TWO_INPUTS] });
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		prompts.push("first", SENT_A);
		const first = await read(iterator, framesBefore(lines, recordedB));
		const held = iterator.next();
		expect(await settlesWithin(held, 50)).toBe(false);
		prompts.push("second", SENT_B);
		const queued = await held;
		expect(queued.value).toMatchObject({
			type: "command_lifecycle",
			command_uuid: SENT_B,
			state: "queued",
		});
		const rest = await read(iterator, lines.length - first.length - 1);
		prompts.close();
		expect(await iterator.next()).toEqual({ done: true, value: undefined });

		const replayed = [
			...first,
			...(queued.value ? [queued.value] : []),
			...rest,
		];
		expect(replayed).toHaveLength(lines.length);
		expect(
			replayed.flatMap((message) =>
				message.type === "result" ? [message.user_message_uuids] : [],
			),
		).toEqual([[SENT_A], [SENT_B]]);
		const json = JSON.stringify(replayed);
		expect(json).not.toContain(recordedA);
		expect(json).not.toContain(recordedB);
		replayer.assertComplete();
	});

	// Failure 6.
	it("fails the stream and assertComplete on a prompt no recorded input matches", async () => {
		const replayer = createClaudeTraceReplayer({ turns: [TWO_INPUTS] });
		const prompts = promptQueue();
		const iterator = replayer.sdk
			.query({ prompt: prompts.iterable })
			[Symbol.asyncIterator]();

		prompts.push("a", SENT_A);
		prompts.push("b", SENT_B);
		prompts.push("c", SENT_C);
		await read(iterator, traceLineCount(TWO_INPUTS));

		const unmatched =
			/prompt 3 was sent, but no recorded input matches it \(the plan records 2\)/;
		await expect(iterator.next()).rejects.toThrow(unmatched);
		expect(() => replayer.assertComplete()).toThrow(unmatched);
	});

	// Failure 7.
	it("fails assertComplete when a recorded input is never sent", async () => {
		const lines = traceJson(TWO_INPUTS);
		const [, recordedB = ""] = recordedInputs(lines);
		const replayer = createClaudeTraceReplayer({ turns: [TWO_INPUTS] });
		const prompts = promptQueue();
		const query = replayer.sdk.query({ prompt: prompts.iterable });
		const iterator = query[Symbol.asyncIterator]();

		prompts.push("a", SENT_A);
		await read(iterator, framesBefore(lines, recordedB));
		const held = iterator.next();
		expect(await settlesWithin(held, 50)).toBe(false);
		expect(() => replayer.assertComplete()).toThrow(
			/recorded input 2 of trace 1 \(second-input-held-to-turn-end\) was never sent \(1 of 2/,
		);

		query.close();
		expect(await held).toEqual({ done: true, value: undefined });
		expect(() => replayer.assertComplete()).toThrow(
			/recorded input 2 of trace 1 \(second-input-held-to-turn-end\) was never sent: the query closed while the replay held for it/,
		);
	});

	// Failure 8.
	it("throws at creation when a frame names a later input before its queued frame", () => {
		const lines = traceJson(TWO_INPUTS);
		const [, recordedB = ""] = recordedInputs(lines);
		const dir = writeTrace(
			lines.filter((_, index) => index !== framesBefore(lines, recordedB)),
		);

		expect(() =>
			createClaudeTraceReplayer({ turns: [TWO_INPUTS], tracesDir: dir }),
		).toThrow(
			/second-input-held-to-turn-end\.jsonl:\d+ references recorded input 2 before its command_lifecycle queued frame, so its id would be mapped out of order/,
		);
	});

	// Failure 9.
	it("rejects an interrupt the trace does not record, and fails assertComplete", async () => {
		const replayer = createClaudeTraceReplayer({ turns: [TWO_INPUTS] });
		const prompts = promptQueue();
		const query = replayer.sdk.query({ prompt: prompts.iterable });
		const iterator = query[Symbol.asyncIterator]();

		prompts.push("a", SENT_A);
		await iterator.next();

		const unrecorded =
			/interrupt\(\) arrived during second-input-held-to-turn-end, which records no further interrupt/;
		await expect(query.interrupt()).rejects.toThrow(unrecorded);
		expect(() => replayer.assertComplete()).toThrow(unrecorded);
	});

	it("answers a recorded interrupt with the inputs still queued there", async () => {
		// The two-input trace, cut as the spike's interrupt-steer run shows it
		// (docs/plans/2026-10-05-steer-and-queue/claude-spike/out-interrupt-steer.txt):
		// the second input queues while the tool runs, Stop cancels the first,
		// and the second then runs as its own turn.
		const lines = traceJson(TWO_INPUTS);
		const [recordedA = "", recordedB = ""] = recordedInputs(lines);
		const at = (predicate: (line: Raw) => boolean) => {
			const line = lines.find(predicate);
			if (!line) throw new Error("two-input trace changed shape");
			return line;
		};
		const lifecycle = (id: string, state: string) => (line: Raw) =>
			line["type"] === "command_lifecycle" &&
			line["command_uuid"] === id &&
			line["state"] === state;
		const toolRunning = lines.findIndex(
			(line) => line["subtype"] === "task_started",
		);
		const toolResult = at((line) => line["type"] === "user");
		const resultA = at(
			(line) =>
				line["type"] === "result" &&
				JSON.stringify(line["user_message_uuids"]) ===
					JSON.stringify([recordedA]),
		);
		const startedB = lines.findIndex(lifecycle(recordedB, "started"));
		const interrupted: Raw[] = [
			...lines.slice(0, toolRunning),
			at(lifecycle(recordedB, "queued")),
			toolResult,
			{
				...toolResult,
				uuid: "6f1f3b7e-0000-4000-8000-000000000001",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "[Request interrupted by user for tool use]",
						},
					],
				},
			},
			{
				...resultA,
				subtype: "error_during_execution",
				is_error: true,
				result: undefined,
				errors: [],
			},
			{ ...at(lifecycle(recordedA, "completed")), state: "cancelled" },
			...lines.slice(startedB),
		];
		const replayer = createClaudeTraceReplayer({
			turns: [TWO_INPUTS],
			tracesDir: writeTrace(interrupted),
		});
		const prompts = promptQueue();
		const query = replayer.sdk.query({ prompt: prompts.iterable });
		const iterator = query[Symbol.asyncIterator]();

		prompts.push("a", SENT_A);
		await read(iterator, toolRunning);
		prompts.push("b", SENT_B);
		await read(iterator, 1);
		const held = iterator.next();
		expect(await settlesWithin(held, 50)).toBe(false);

		await expect(query.interrupt()).resolves.toEqual({
			still_queued: [SENT_B],
		});
		expect((await held).value).toMatchObject({ type: "user" });
		const rest = await read(iterator, interrupted.length - toolRunning - 2);
		expect(rest.slice(0, 3)).toMatchObject([
			{ type: "user" },
			{ type: "result", subtype: "error_during_execution" },
			{ type: "command_lifecycle", command_uuid: SENT_A, state: "cancelled" },
		]);
		expect(rest.at(-2)).toMatchObject({
			type: "result",
			user_message_uuids: [SENT_B],
		});
		replayer.assertComplete();

		await expect(query.interrupt()).rejects.toThrow(
			/records no further interrupt/,
		);
	});
});
