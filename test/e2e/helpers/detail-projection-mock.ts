import type { Page } from "@playwright/test";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import { MOCK_NOW_MS, type MockMessage } from "../fixtures/mockup-state.js";

type PendingInput = {
	inputId: string;
	state: "queued" | "steering";
	request: {
		text: string;
		images?: { attachmentHash: string; mime: string; name?: string }[];
	};
	admittedAt: number;
};
type DetailItem =
	| { _tag: "message"; message: HistoryMessage }
	| {
			_tag: "part";
			messageId: string;
			sortOrder: number;
			part: HistoryMessagePart;
	  }
	| { _tag: "pendingInput"; input: PendingInput }
	| { _tag: "inbox"; inbox: Inbox };
type Inbox = { paused: boolean; steer: "no_steering" | "prompt_open" | null };
type DetailEnvelope =
	| { _tag: "snapshot"; rows: DetailItem[]; sequence: number; hasMore: boolean }
	| { _tag: "upsert"; item: DetailItem; sequence: number }
	| { _tag: "remove"; id: string; sequence: number };
type Listener = (sessionId: string, envelope: DetailEnvelope) => void;

interface SessionProjection {
	rows: Map<string, HistoryMessage>;
	pending: Map<string, PendingInput>;
	inbox: Inbox;
	sequence: number;
	hasMore: boolean;
	assistantId: string | null;
	textPartId: string | null;
	thinkingPartId: string | null;
}

const projections = new WeakMap<Page, Map<string, SessionProjection>>();
const listeners = new WeakMap<Page, Listener>();

function session(page: Page, sessionId: string): SessionProjection {
	let bySession = projections.get(page);
	if (!bySession) {
		bySession = new Map();
		projections.set(page, bySession);
	}
	let projection = bySession.get(sessionId);
	if (!projection) {
		projection = {
			rows: new Map(),
			pending: new Map(),
			inbox: { paused: false, steer: null },
			sequence: 0,
			hasMore: false,
			assistantId: null,
			textPartId: null,
			thinkingPartId: null,
		};
		bySession.set(sessionId, projection);
	}
	return projection;
}

const isHistoryMessage = (value: unknown): value is HistoryMessage =>
	typeof value === "object" &&
	value !== null &&
	"id" in value &&
	typeof value.id === "string" &&
	"role" in value &&
	(value.role === "user" || value.role === "assistant");

// Recorded fixtures keep the old raw tool state; the wire now tags it (y7eo.6).
const tagged = (value: unknown): boolean =>
	typeof value === "object" && value !== null && "_tag" in value;
export const toWire = (message: HistoryMessage): HistoryMessage => ({
	...message,
	...(message.parts && {
		parts: message.parts.map((part) => {
			const state: Record<string, unknown> | undefined = part.state;
			if (!state) return part;
			const { input, output } = state;
			return {
				...part,
				state: {
					...part.state,
					...(input !== undefined &&
						!tagged(input) && {
							input: { _tag: "whole" as const, value: input },
						}),
					...(typeof output === "string" && {
						output: { _tag: "whole" as const, text: output },
					}),
				},
			};
		}),
	}),
});

// A message travels as its header, then each part as a row of its own.
const items = ({ parts = [], ...message }: HistoryMessage): DetailItem[] => [
	{ _tag: "message", message },
	...parts.map((part, sortOrder) => ({
		_tag: "part" as const,
		messageId: message.id,
		sortOrder,
		part,
	})),
];

const sortedRows = (state: SessionProjection): HistoryMessage[] =>
	[...state.rows.values()].sort(
		(a, b) =>
			(a.time?.created ?? 0) - (b.time?.created ?? 0) ||
			a.id.localeCompare(b.id),
	);

// Explicit scenario times may be later than the default epoch. Keep generated
// events after those rows, with stable ordering even when the clock is fixed.
const nextTimestamp = (state: SessionProjection): number =>
	[...state.rows.values()].reduce(
		(latest, message) =>
			Math.max(
				latest,
				message.time?.created ?? 0,
				message.time?.completed ?? 0,
			),
		MOCK_NOW_MS,
	) + state.sequence;

const snapshot = (state: SessionProjection): DetailEnvelope => {
	const rows = sortedRows(state);
	return {
		_tag: "snapshot",
		rows: [
			...rows.slice(-50).flatMap(items),
			...[...state.pending.values()].map(
				(input): DetailItem => ({ _tag: "pendingInput", input }),
			),
			{ _tag: "inbox", inbox: state.inbox },
		],
		sequence: state.sequence,
		hasMore: state.hasMore || rows.length > 50,
	};
};

function upsert(page: Page, sessionId: string, message: HistoryMessage): void {
	const state = session(page, sessionId);
	state.rows.set(message.id, message);
	const sequence = ++state.sequence;
	for (const item of items(message))
		listeners.get(page)?.(sessionId, { _tag: "upsert", item, sequence });
}

function replacePart(
	message: HistoryMessage,
	part: HistoryMessagePart,
): HistoryMessage {
	return {
		...message,
		parts: [...(message.parts ?? []).filter((old) => old.id !== part.id), part],
	};
}

function assistant(
	state: SessionProjection,
	event: MockMessage,
): HistoryMessage {
	const id =
		typeof event["messageId"] === "string"
			? event["messageId"]
			: (state.assistantId ?? `mock-assistant-${state.sequence + 1}`);
	state.assistantId = id;
	return (
		state.rows.get(id) ?? {
			id,
			role: "assistant",
			time: {
				created:
					typeof event["createdAt"] === "number"
						? event["createdAt"]
						: nextTimestamp(state),
			},
			parts: [],
		}
	);
}

/** Fold recorded relay content into the whole-row detail envelopes the UI now consumes. */
export function projectLegacyRelayMessage(
	page: Page,
	event: MockMessage,
): boolean {
	const sessionId =
		typeof event["sessionId"] === "string"
			? event["sessionId"]
			: event.type === "mock_transcript_snapshot" &&
					typeof event["id"] === "string"
				? event["id"]
				: null;
	if (!sessionId) return false;
	const state = session(page, sessionId);
	if (event.type === "mock_transcript_snapshot") {
		const listener = listeners.get(page);
		listeners.delete(page);
		const history = event["history"];
		const messages =
			typeof history === "object" &&
			history !== null &&
			"messages" in history &&
			Array.isArray(history.messages)
				? history.messages.filter(isHistoryMessage).map(toWire)
				: null;
		if (messages) {
			state.rows = new Map(messages.map((message) => [message.id, message]));
			state.sequence++;
			state.hasMore =
				typeof history === "object" &&
				history !== null &&
				"hasMore" in history &&
				history.hasMore === true;
		}
		const events = event["events"];
		if (Array.isArray(events))
			for (const child of events)
				if (
					typeof child === "object" &&
					child !== null &&
					"type" in child &&
					typeof child.type === "string"
				)
					projectLegacyRelayMessage(page, { ...child, sessionId });
		if (listener) {
			listeners.set(page, listener);
			if (messages || Array.isArray(events))
				listener(sessionId, snapshot(state));
		}
		return true;
	}
	// Mock-only: the server's pending-input rows, which the browser renders as
	// the tray above the composer.
	if (
		event.type === "mock_pending_input" &&
		typeof event["inputId"] === "string" &&
		typeof event["text"] === "string"
	) {
		const images = event["images"];
		const input: PendingInput = {
			inputId: event["inputId"],
			state: event["state"] === "steering" ? "steering" : "queued",
			request: {
				text: event["text"],
				...(Array.isArray(images)
					? {
							images: images.map((image) => ({
								attachmentHash: String(image.attachmentHash),
								mime: String(image.mime),
							})),
						}
					: {}),
			},
			admittedAt:
				state.pending.get(event["inputId"])?.admittedAt ?? nextTimestamp(state),
		};
		state.pending.set(input.inputId, input);
		const sequence = ++state.sequence;
		listeners.get(page)?.(sessionId, {
			_tag: "upsert",
			item: { _tag: "pendingInput", input },
			sequence,
		});
		return true;
	}
	// Mock-only: the server's derived pause and steer reason, the inbox arm.
	if (event.type === "mock_inbox") {
		const steer = event["steer"];
		state.inbox = {
			paused:
				typeof event["paused"] === "boolean"
					? event["paused"]
					: state.inbox.paused,
			steer:
				steer === "no_steering" || steer === "prompt_open" || steer === null
					? steer
					: state.inbox.steer,
		};
		const sequence = ++state.sequence;
		listeners.get(page)?.(sessionId, {
			_tag: "upsert",
			item: { _tag: "inbox", inbox: state.inbox },
			sequence,
		});
		return true;
	}
	if (
		event.type === "mock_pending_input_removed" &&
		typeof event["inputId"] === "string"
	) {
		state.pending.delete(event["inputId"]);
		const sequence = ++state.sequence;
		listeners.get(page)?.(sessionId, {
			_tag: "remove",
			id: `input:${event["inputId"]}`,
			sequence,
		});
		return true;
	}
	if (event.type === "user_message" && typeof event["text"] === "string") {
		const id =
			typeof event["messageId"] === "string"
				? event["messageId"]
				: `mock-user-${state.sequence + 1}`;
		upsert(page, sessionId, {
			id,
			role: "user",
			time: {
				created:
					typeof event["createdAt"] === "number"
						? event["createdAt"]
						: nextTimestamp(state),
			},
			parts: [{ id: `${id}-text`, type: "text", text: event["text"] }],
			...(typeof event["inputId"] === "string"
				? { inputId: event["inputId"] }
				: {}),
			...(event["steered"] === true ? { steered: true } : {}),
		});
		return true;
	}
	if (event.type === "delta" && typeof event["text"] === "string") {
		const message = assistant(state, event);
		const partId =
			typeof event["partId"] === "string"
				? event["partId"]
				: (state.textPartId ?? `${message.id}-text`);
		state.textPartId = partId;
		const previous = message.parts?.find((part) => part.id === partId);
		upsert(
			page,
			sessionId,
			replacePart(message, {
				id: partId,
				type: "text",
				text: (previous?.text ?? "") + event["text"],
			}),
		);
		return true;
	}
	if (event.type === "thinking_start" || event.type === "thinking_delta") {
		const message = assistant(state, event);
		const partId =
			typeof event["partId"] === "string"
				? event["partId"]
				: (state.thinkingPartId ?? `${message.id}-thinking`);
		state.thinkingPartId = partId;
		const previous = message.parts?.find((part) => part.id === partId);
		upsert(
			page,
			sessionId,
			replacePart(message, {
				id: partId,
				type: "thinking",
				text:
					(previous?.text ?? "") +
					(event.type === "thinking_delta" && typeof event["text"] === "string"
						? event["text"]
						: ""),
			}),
		);
		return true;
	}
	if (event.type === "tool_start" && typeof event["id"] === "string") {
		const message = assistant(state, event);
		upsert(
			page,
			sessionId,
			replacePart(message, {
				id: event["id"],
				type: "tool",
				callID: event["id"],
				tool: typeof event["name"] === "string" ? event["name"] : "unknown",
				state: { status: "pending" },
			}),
		);
		return true;
	}
	if (event.type === "tool_executing" && typeof event["id"] === "string") {
		for (const message of state.rows.values()) {
			const part = message.parts?.find(
				(candidate) =>
					candidate.callID === event["id"] || candidate.id === event["id"],
			);
			if (!part) continue;
			upsert(
				page,
				sessionId,
				replacePart(message, {
					...part,
					state: {
						...part.state,
						status: "running",
						...(event["input"] !== undefined
							? { input: { _tag: "whole" as const, value: event["input"] } }
							: {}),
					},
				}),
			);
			break;
		}
		return true;
	}
	if (event.type === "tool_result" && typeof event["id"] === "string") {
		for (const message of state.rows.values()) {
			const part = message.parts?.find(
				(candidate) =>
					candidate.callID === event["id"] || candidate.id === event["id"],
			);
			if (!part) continue;
			upsert(
				page,
				sessionId,
				replacePart(message, {
					...part,
					state: {
						...part.state,
						status: event["is_error"] === true ? "error" : "completed",
						...(typeof event["content"] === "string"
							? { output: { _tag: "whole" as const, text: event["content"] } }
							: {}),
					},
				}),
			);
			break;
		}
		return true;
	}
	if (event.type === "result" || event.type === "done") {
		const id =
			typeof event["messageId"] === "string"
				? event["messageId"]
				: state.assistantId;
		const message = id ? state.rows.get(id) : undefined;
		if (message)
			upsert(page, sessionId, {
				...message,
				time: {
					...message.time,
					completed:
						typeof event["createdAt"] === "number"
							? event["createdAt"]
							: nextTimestamp(state),
				},
				...(typeof event["cost"] === "number" ? { cost: event["cost"] } : {}),
			});
		if (event.type === "done") {
			state.assistantId = null;
			state.textPartId = null;
			state.thinkingPartId = null;
		}
		return true;
	}
	// Like the message projector: a compaction's outcome is its own synthetic
	// message; the "started" notice stays transient.
	if (
		event.type === "compaction" &&
		(event["state"] === "completed" || event["state"] === "failed")
	) {
		const id = `compaction-${state.sequence + 1}`;
		const created = nextTimestamp(state);
		const clearedContext =
			event["provider"] === "opencode" &&
			event["state"] === "completed" &&
			event["postTokens"] === undefined;
		upsert(page, sessionId, {
			id,
			role: "assistant",
			time: { created, ...(clearedContext ? { completed: created } : {}) },
			...(clearedContext ? { contextTokens: 0 } : {}),
			parts: [
				{
					id: `compaction-part-${state.sequence + 1}`,
					type: "compaction",
					...(typeof event["detail"] === "string"
						? { text: event["detail"] }
						: {}),
					...(typeof event["preTokens"] === "number"
						? { preTokens: event["preTokens"] }
						: {}),
					...(typeof event["postTokens"] === "number"
						? { postTokens: event["postTokens"] }
						: {}),
					...(event["state"] === "failed" ? { failed: true } : {}),
				},
			],
		});
		return true;
	}
	if (
		event.type === "message_removed" &&
		typeof event["messageId"] === "string"
	) {
		state.rows.delete(event["messageId"]);
		const sequence = ++state.sequence;
		listeners.get(page)?.(sessionId, {
			_tag: "remove",
			id: event["messageId"],
			sequence,
		});
		return true;
	}
	return false;
}

export function mockDetailSnapshot(
	page: Page,
	sessionId: string,
): DetailEnvelope {
	return snapshot(session(page, sessionId));
}

export function mockDetailPage(
	page: Page,
	sessionId: string,
	before: string | undefined,
): {
	messages: HistoryMessage[];
	hasMore: boolean;
} {
	const rows = sortedRows(session(page, sessionId));
	const floor =
		before === undefined
			? rows.length
			: rows.findIndex((row) => row.id === before);
	const older = rows.slice(0, floor < 0 ? 0 : floor);
	return { messages: older.slice(-50), hasMore: older.length > 50 };
}

export function subscribeMockDetail(page: Page, listener: Listener): void {
	listeners.set(page, listener);
}
