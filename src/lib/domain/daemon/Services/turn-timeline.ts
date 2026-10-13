import { performance } from "node:perf_hooks";
import type { StoredEvent } from "../../../contracts/stored-event.js";
import type { ClaudeSessionOutput } from "../../../provider/claude/claude-session-runner.js";
import { isRecord } from "../../../utils.js";
import type { TraceSink } from "./local-trace-artifact.js";

const phases = [
	"admitted",
	"reactor-start",
	"history-ready",
	"runner-ready",
	"prompt-delivered",
	"first-frame-received",
	"first-delta-committed",
	"first-socket-write",
] as const;
type Phase = (typeof phases)[number];
export interface TurnKey {
	readonly sessionId: string;
	readonly inputId: string;
}
export interface TurnTimelineRecord extends TurnKey {
	readonly type: "turn-timeline";
	readonly schemaVersion: 1;
	readonly service: "conduit-daemon";
	readonly startedAt: number;
	readonly durationMs: number;
	readonly closedBy: "first-socket-write" | "timeout";
	readonly timeoutReason?: "deadline" | "capacity" | "shutdown";
	readonly phases: readonly {
		readonly phase: Phase;
		readonly elapsedMs: number;
		readonly deltaMs: number;
		readonly approximation?: "first-frame-received";
	}[];
	readonly missingPhases: readonly Phase[];
}

const MAX_PENDING_TURNS = 512;
const MAX_CLOSED_TURNS = 4096;
const MAX_ASSISTANT_MESSAGES = 32;
const TURN_TIMEOUT_MS = 300_000;
interface PendingTurn {
	readonly key: TurnKey;
	readonly startedAt: number;
	readonly start: number;
	readonly times: Map<Phase, number>;
	readonly timer: NodeJS.Timeout;
	readonly assistantMessages: Set<string>;
	sinkId?: string;
	partKey?: string;
}

interface Timeline {
	readonly pending: Map<string, PendingTurn>;
	readonly closed: Set<string>;
	readonly sinks: Map<string, string>;
	readonly parts: Map<string, string>;
	readonly close: (
		id: string,
		closedBy: TurnTimelineRecord["closedBy"],
		timeoutReason?: TurnTimelineRecord["timeoutReason"],
	) => void;
}
const scopes: Timeline[] = [];
let active: Timeline | undefined;
const turnId = (key: TurnKey) => JSON.stringify([key.sessionId, key.inputId]);
const partId = (messageId: string, partId: string) =>
	JSON.stringify([messageId, partId]);

/** The tracing scope owns all timers and correlations; disabled tracing is inert. */
export const attachTurnTimeline = (sink: TraceSink): (() => void) => {
	const pending = new Map<string, PendingTurn>();
	const closed = new Set<string>();
	const sinks = new Map<string, string>();
	const parts = new Map<string, string>();
	const close = (
		id: string,
		closedBy: TurnTimelineRecord["closedBy"],
		timeoutReason?: TurnTimelineRecord["timeoutReason"],
	) => {
		const turn = pending.get(id);
		if (!turn) return;
		clearTimeout(turn.timer);
		pending.delete(id);
		if (turn.sinkId) sinks.delete(turn.sinkId);
		if (turn.partKey) parts.delete(turn.partKey);
		closed.add(id);
		if (closed.size > MAX_CLOSED_TURNS) {
			const oldest = closed.values().next().value;
			if (oldest !== undefined) closed.delete(oldest);
		}
		let previous = 0;
		sink.writeSync({
			type: "turn-timeline",
			schemaVersion: 1,
			service: "conduit-daemon",
			...turn.key,
			startedAt: turn.startedAt,
			durationMs: performance.now() - turn.start,
			closedBy,
			...(timeoutReason ? { timeoutReason } : {}),
			phases: phases.flatMap((phase) => {
				const elapsedMs = turn.times.get(phase);
				if (elapsedMs === undefined) return [];
				const deltaMs = elapsedMs - previous;
				previous = elapsedMs;
				return [
					{
						phase,
						elapsedMs,
						deltaMs,
						...(phase === "runner-ready" || phase === "prompt-delivered"
							? { approximation: "first-frame-received" as const }
							: {}),
					},
				];
			}),
			missingPhases: phases.filter((phase) => !turn.times.has(phase)),
		});
	};
	const owner = { pending, closed, sinks, parts, close };
	scopes.push(owner);
	active = owner;
	return () => {
		const index = scopes.indexOf(owner);
		if (index === -1) return;
		for (const id of pending.keys()) close(id, "timeout", "shutdown");
		closed.clear();
		scopes.splice(index, 1);
		active = scopes.at(-1);
	};
};

/** Repeated marks never reset a queued admission or an earlier attempt's phase. */
export const mark = (key: TurnKey, phase: Phase): void => {
	if (!active) return;
	const id = turnId(key);
	if (active.closed.has(id)) return;
	let turn = active.pending.get(id);
	if (!turn) {
		if (phase !== "admitted") return;
		if (active.pending.size >= MAX_PENDING_TURNS) {
			const oldest = active.pending.keys().next().value;
			if (oldest !== undefined) active.close(oldest, "timeout", "capacity");
		}
		const owner = active;
		const timer = setTimeout(
			() => owner.close(id, "timeout", "deadline"),
			TURN_TIMEOUT_MS,
		);
		timer.unref();
		turn = {
			key,
			startedAt: Date.now(),
			start: performance.now(),
			times: new Map(),
			timer,
			assistantMessages: new Set(),
		};
		active.pending.set(id, turn);
	}
	if (turn.times.has(phase)) return;
	for (const observed of turn.times.keys())
		if (phases.indexOf(observed) > phases.indexOf(phase)) return;
	turn.times.set(phase, performance.now() - turn.start);
	if (phase === "first-socket-write") active.close(id, "first-socket-write");
};

/** Sink ids distinguish queued, concurrent and retried sends of one session. */
export const bindTurnTimelineSink = (sinkId: string, key: TurnKey): void => {
	if (!active) return;
	const id = turnId(key);
	const turn = active.pending.get(id);
	if (!turn) return;
	if (turn.sinkId) active.sinks.delete(turn.sinkId);
	turn.sinkId = sinkId;
	active.sinks.set(sinkId, id);
};

export const observeTurnTimelineFrame = (output: ClaudeSessionOutput): void => {
	if (!active || output.type === "background-task") return;
	const id = active.sinks.get(output.sinkId);
	const turn = id === undefined ? undefined : active.pending.get(id);
	if (!turn) return;
	// These runner-internal phases have no independent timestamp in the protocol.
	mark(turn.key, "runner-ready");
	mark(turn.key, "prompt-delivered");
	mark(turn.key, "first-frame-received");
	if (
		output.type !== "event" ||
		output.event.sessionId !== turn.key.sessionId ||
		turn.partKey !== undefined
	)
		return;
	const data: unknown = output.event.data;
	if (!isRecord(data) || typeof data["messageId"] !== "string") return;
	if (output.event.type === "message.created" && data["role"] === "assistant") {
		turn.assistantMessages.add(data["messageId"]);
		if (turn.assistantMessages.size > MAX_ASSISTANT_MESSAGES) {
			const oldest = turn.assistantMessages.values().next().value;
			if (oldest !== undefined) turn.assistantMessages.delete(oldest);
		}
		return;
	}
	if (
		output.event.type !== "text.delta" ||
		!turn.assistantMessages.has(data["messageId"]) ||
		typeof data["partId"] !== "string" ||
		typeof data["text"] !== "string" ||
		data["text"].length === 0
	)
		return;
	turn.partKey = partId(data["messageId"], data["partId"]);
	turn.assistantMessages.clear();
	active.parts.set(turn.partKey, turnId(turn.key));
};

/** Called after the outer COMMIT and before subscribers can observe its rows. */
export const observeTurnTimelineCommit = (
	events: readonly StoredEvent[],
): void => {
	if (!active) return;
	for (const event of events) {
		if (event.type === "input.admitted") {
			mark(
				{ sessionId: event.sessionId, inputId: event.data.inputId },
				"admitted",
			);
		} else if (event.type === "text.delta" && event.data.text.length > 0) {
			const id = active.parts.get(
				partId(event.data.messageId, event.data.partId),
			);
			const turn = id === undefined ? undefined : active.pending.get(id);
			if (turn?.key.sessionId === event.sessionId)
				mark(turn.key, "first-delta-committed");
		}
	}
};

/** Whether a socket write could complete a turn; callers skip all write work otherwise. */
export const turnTimelineAwaitsSocketWrite = (): boolean =>
	active !== undefined && active.parts.size > 0;

/** Called only by a successful native send callback, after bytes reach the socket. */
export const observeTurnTimelineSocketWrite = (
	data: string | Uint8Array,
): void => {
	if (!active || active.parts.size === 0) return;
	let response: unknown;
	try {
		response = JSON.parse(
			typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
		);
	} catch {
		return;
	}
	if (
		!isRecord(response) ||
		response["_tag"] !== "Chunk" ||
		!Array.isArray(response["values"])
	)
		return;
	for (const envelope of response["values"]) {
		if (!isRecord(envelope)) continue;
		const rows =
			envelope["_tag"] === "snapshot" && Array.isArray(envelope["rows"])
				? envelope["rows"]
				: envelope["_tag"] === "upsert"
					? [envelope["item"]]
					: [];
		for (const row of rows) {
			if (
				!isRecord(row) ||
				row["_tag"] !== "part" ||
				typeof row["messageId"] !== "string" ||
				!isRecord(row["part"])
			)
				continue;
			const part = row["part"];
			if (
				part["type"] !== "text" ||
				typeof part["id"] !== "string" ||
				typeof part["text"] !== "string" ||
				part["text"].length === 0
			)
				continue;
			const id = active.parts.get(partId(row["messageId"], part["id"]));
			const turn = id === undefined ? undefined : active.pending.get(id);
			if (turn?.times.has("first-delta-committed"))
				mark(turn.key, "first-socket-write");
		}
	}
};
