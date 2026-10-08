// A generated session store for load tests: ~10k sessions in families plus
// one heavy session, seeded through canonical events and the real projectors.
// The process harness seeds it into a project store before a daemon start;
// read-query tests can seed it into any SQLite file. Everything but event ids
// is deterministic, so byte counts are stable from run to run.

import { Effect } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
	ToolStartedPayload,
} from "../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";

export interface SessionLoadFixture {
	/** Root, sub-agent child, fork and side thread per family. */
	readonly families: number;
	readonly sessions: number;
	readonly events: number;
	readonly heavySessionId: string;
	/** Text of the heavy session's newest assistant message. */
	readonly heavyFinalText: string;
	readonly seedMs: number;
}

const BASE_TIME = Date.UTC(2026, 0, 1);

// Code-like text with enough entropy that compression ratios look real.
const codeText = (seed: number, bytes: number): string => {
	let state = seed >>> 0 || 1;
	const word = () => {
		state = (state * 1_103_515_245 + 12_345) >>> 0;
		return state.toString(36);
	};
	const lines: string[] = [];
	let length = 0;
	while (length < bytes) {
		const line = `\tconst ${word()} = ${word()}(${word()}, "${word()}"); // ${word()} ${word()}`;
		lines.push(line);
		length += line.length + 1;
	}
	return lines.join("\n").slice(0, bytes);
};

const turn = (
	sessionId: string,
	at: number,
	prompt: string,
	reply: string,
	parts: (assistantId: string) => readonly CanonicalEvent[] = () => [],
): CanonicalEvent[] => {
	const userId = `${sessionId}-u${at}`;
	const assistantId = `${sessionId}-a${at}`;
	const event = <T extends CanonicalEventType>(
		type: T,
		data: EventPayloadMap[T],
	) =>
		canonicalEvent(type, sessionId, data, {
			provider: "claude",
			createdAt: at,
		});
	return [
		event("message.created", { messageId: userId, role: "user", sessionId }),
		event("text.delta", {
			messageId: userId,
			partId: `${userId}-0`,
			text: prompt,
		}),
		event("message.created", {
			messageId: assistantId,
			role: "assistant",
			sessionId,
		}),
		...parts(assistantId),
		event("text.delta", {
			messageId: assistantId,
			partId: `${assistantId}-text`,
			text: reply,
		}),
		event("turn.completed", {
			messageId: assistantId,
			tokens: { input: 1200, output: 300 },
			duration: 4000,
		}),
	];
};

const created = (
	sessionId: string,
	at: number,
	title: string,
	lineage: {
		readonly parentId?: string;
		readonly forkPointMessageId?: string;
		readonly sideThread?: boolean;
	} = {},
): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title,
			provider: "claude",
			providerSessionId: sessionId,
			...(lineage.parentId === undefined ? {} : { parentId: lineage.parentId }),
			...(lineage.forkPointMessageId === undefined
				? {}
				: {
						forkPointEvent: lineage.forkPointMessageId,
						forkPointMessageId: lineage.forkPointMessageId,
						forkPointTimestamp: at,
					}),
			...(lineage.sideThread
				? { sideThread: true, permissionMode: "plan" as const }
				: {}),
		},
		{ provider: "claude", createdAt: at },
	);

// One family is four sessions: a root, the sub-agent it spawned, a fork of
// it and a side thread off it. Only the root reaches the sidebar.
const family = (index: number): CanonicalEvent[] => {
	const at = BASE_TIME + index * 60_000;
	const root = `load-f${index}`;
	const forkPoint = `${root}-a${at}`;
	return [
		created(root, at, `Family ${index}: refactor module ${index % 97}`),
		...turn(
			root,
			at,
			`Refactor module ${index}`,
			`Refactored module ${index}.`,
		),
		created(`${root}-agent`, at + 1, `Explore module ${index}`, {
			parentId: root,
		}),
		...turn(`${root}-agent`, at + 1, "Explore", `Found ${index % 13} callers.`),
		created(`${root}-fork`, at + 2, `Fork of family ${index}`, {
			parentId: root,
			forkPointMessageId: forkPoint,
		}),
		...turn(`${root}-fork`, at + 2, "Try another way", "Tried it."),
		created(`${root}-side`, at + 3, `Side question ${index}`, {
			parentId: root,
			forkPointMessageId: forkPoint,
			sideThread: true,
		}),
		...turn(`${root}-side`, at + 3, "Why?", "Because."),
	];
};

// Every turn writes a file, runs a command and reads a file, with inputs and
// outputs in the tens of kilobytes: the session a slow open is felt on.
const heavyTurns = (sessionId: string, turns: number, start: number) =>
	Array.from({ length: turns }, (_, index) => {
		const at = start + index * 1000;
		const tool = (
			assistantId: string,
			name: string,
			input: ToolStartedPayload["input"],
			result: string,
		): CanonicalEvent[] => {
			const partId = `${assistantId}-${name}`;
			const data = { messageId: assistantId, partId };
			return [
				canonicalEvent(
					"tool.started",
					sessionId,
					{ ...data, toolName: name, callId: partId, input },
					{ provider: "claude", createdAt: at },
				),
				canonicalEvent("tool.running", sessionId, data, {
					provider: "claude",
					createdAt: at,
				}),
				canonicalEvent(
					"tool.completed",
					sessionId,
					{ ...data, result, duration: 250 },
					{ provider: "claude", createdAt: at },
				),
			];
		};
		return turn(
			sessionId,
			at,
			`Step ${index}: ${codeText(index, 400)}`,
			index === turns - 1 ? HEAVY_FINAL_TEXT : `Finished step ${index}.`,
			(assistantId) => [
				...tool(
					assistantId,
					"Write",
					{
						tool: "Write",
						filePath: `src/generated/step-${index}.ts`,
						content: codeText(index * 3 + 1, 16_000),
					},
					"File written.",
				),
				...tool(
					assistantId,
					"Bash",
					{
						tool: "Bash",
						command: `pnpm vitest run step-${index} ${codeText(index, 2000)}`,
					},
					codeText(index * 3 + 2, 24_000),
				),
				...tool(
					assistantId,
					"Read",
					{ tool: "Read", filePath: `src/generated/step-${index}.ts` },
					codeText(index * 3 + 3, 32_000),
				),
			],
		);
	});

export const HEAVY_SESSION_ID = "load-heavy";
export const HEAVY_FINAL_TEXT = "Heavy session complete: all steps verified.";

/**
 * Seed the fixture into `filename`, creating and migrating the store if it
 * does not exist. `families` scales the store; the heavy session is always
 * added and is the newest root.
 */
export const seedSessionLoadFixture = async (
	filename: string,
	options: { readonly families?: number; readonly heavyTurns?: number } = {},
): Promise<SessionLoadFixture> => {
	const families = options.families ?? 2500;
	const started = performance.now();
	const heavyStart = BASE_TIME + families * 60_000;
	const events = await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			let count = 0;
			const write = (batch: readonly CanonicalEvent[]) =>
				commit(batch, { publish: false }).pipe(
					Effect.tap(() => {
						count += batch.length;
					}),
				);
			for (let first = 0; first < families; first += 500) {
				yield* write(
					Array.from({ length: Math.min(500, families - first) }, (_, offset) =>
						family(first + offset),
					).flat(),
				);
			}
			yield* write([created(HEAVY_SESSION_ID, heavyStart, "Heavy session")]);
			for (const batch of heavyTurns(
				HEAVY_SESSION_ID,
				options.heavyTurns ?? 60,
				heavyStart,
			))
				yield* write(batch);
			return count;
		}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
	);
	return {
		families,
		sessions: families * 4 + 1,
		events,
		heavySessionId: HEAVY_SESSION_ID,
		heavyFinalText: HEAVY_FINAL_TEXT,
		seedMs: Math.round(performance.now() - started),
	};
};
