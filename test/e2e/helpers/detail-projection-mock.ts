import type { Page } from "@playwright/test";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import type { MockMessage } from "../fixtures/mockup-state.js";

type DetailItem = { _tag: "transcriptMessage"; message: HistoryMessage };
type DetailEnvelope =
	| { _tag: "snapshot"; rows: DetailItem[]; sequence: number; hasMore: boolean }
	| { _tag: "upsert"; item: DetailItem; sequence: number }
	| { _tag: "remove"; id: string; sequence: number };
type Listener = (sessionId: string, envelope: DetailEnvelope) => void;

interface SessionProjection {
	rows: Map<string, HistoryMessage>;
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

const item = (message: HistoryMessage): DetailItem => ({
	_tag: "transcriptMessage",
	message,
});

const sortedRows = (state: SessionProjection): HistoryMessage[] =>
	[...state.rows.values()].sort(
		(a, b) =>
			(a.time?.created ?? 0) - (b.time?.created ?? 0) ||
			a.id.localeCompare(b.id),
	);

const snapshot = (state: SessionProjection): DetailEnvelope => {
	const rows = sortedRows(state);
	return {
		_tag: "snapshot",
		rows: rows.slice(-50).map(item),
		sequence: state.sequence,
		hasMore: state.hasMore || rows.length > 50,
	};
};

function upsert(page: Page, sessionId: string, message: HistoryMessage): void {
	const state = session(page, sessionId);
	state.rows.set(message.id, message);
	const sequence = ++state.sequence;
	listeners.get(page)?.(sessionId, {
		_tag: "upsert",
		item: item(message),
		sequence,
	});
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
			time: { created: Date.now() + state.sequence },
			parts: [],
		}
	);
}

/** Fold recorded relay content into the whole-row detail envelopes the UI now consumes. */
export function projectLegacyRelayMessage(
	page: Page,
	event: MockMessage,
): void {
	const sessionId =
		typeof event["sessionId"] === "string"
			? event["sessionId"]
			: event.type === "session_switched" && typeof event["id"] === "string"
				? event["id"]
				: null;
	if (!sessionId) return;
	const state = session(page, sessionId);
	if (event.type === "session_switched") {
		const listener = listeners.get(page);
		listeners.delete(page);
		const history = event["history"];
		const messages =
			typeof history === "object" &&
			history !== null &&
			"messages" in history &&
			Array.isArray(history.messages)
				? history.messages.filter(isHistoryMessage)
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
		return;
	}
	if (event.type === "user_message" && typeof event["text"] === "string") {
		const id =
			typeof event["messageId"] === "string"
				? event["messageId"]
				: `mock-user-${state.sequence + 1}`;
		upsert(page, sessionId, {
			id,
			role: "user",
			time: { created: Date.now() + state.sequence },
			parts: [{ id: `${id}-text`, type: "text", text: event["text"] }],
		});
		return;
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
		return;
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
		return;
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
		return;
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
							? { output: event["content"] }
							: {}),
					},
				}),
			);
			break;
		}
		return;
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
				time: { ...message.time, completed: Date.now() },
				...(typeof event["cost"] === "number" ? { cost: event["cost"] } : {}),
			});
		if (event.type === "done") {
			state.assistantId = null;
			state.textPartId = null;
			state.thinkingPartId = null;
		}
		return;
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
	}
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
