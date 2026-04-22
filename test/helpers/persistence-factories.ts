import { EventStore } from "../../src/lib/persistence/event-store.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
	type EventId,
	type EventMetadata,
	type EventPayloadMap,
	type StoredEvent,
	validateEventPayload,
} from "../../src/lib/persistence/events.js";
import { runMigrations } from "../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../src/lib/persistence/sqlite-client.js";

export const FIXED_TEST_TIMESTAMP = 1_000_000_000_000;
export const FIXED_TEST_TIMESTAMP_2 = 1_000_000_060_000;

export function makeSessionCreatedEvent(
	sessionId: string,
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
		title?: string;
		provider?: string;
	},
): CanonicalEvent {
	return canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: opts?.title ?? "Test Session",
			provider: opts?.provider ?? "opencode",
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeTextDelta(
	sessionId: string,
	messageId: string,
	text: string,
	opts?: {
		eventId?: EventId;
		partId?: string;
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent(
		"text.delta",
		sessionId,
		{
			messageId,
			partId: opts?.partId ?? "p1",
			text,
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeMessageCreatedEvent(
	sessionId: string,
	messageId: string,
	opts?: {
		eventId?: EventId;
		role?: "user" | "assistant";
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent(
		"message.created",
		sessionId,
		{
			messageId,
			role: opts?.role ?? "assistant",
			sessionId,
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeSessionStatusEvent(
	sessionId: string,
	status: "idle" | "busy" | "error",
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent(
		"session.status",
		sessionId,
		{
			sessionId,
			status,
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: EventPayloadMap[T],
	opts?: {
		sequence?: number;
		createdAt?: number;
		streamVersion?: number;
		eventId?: EventId;
		metadata?: EventMetadata;
	},
): StoredEvent {
	const sequence = opts?.sequence ?? 1;
	if (sequence < 1) {
		throw new Error(`makeStored: sequence must be >= 1, got ${sequence}`);
	}

	const streamVersion = opts?.streamVersion ?? 0;
	if (streamVersion < 0) {
		throw new Error(
			`makeStored: streamVersion must be >= 0, got ${streamVersion}`,
		);
	}

	const event = canonicalEvent(type, sessionId, data, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});

	validateEventPayload(event);

	return { ...event, sequence, streamVersion } as StoredEvent;
}

export interface SessionSeedOpts {
	provider?: string;
	title?: string;
	status?: string;
	parentId?: string;
	forkPointEvent?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface MessageSeedOpts {
	role?: "user" | "assistant";
	createdAt?: number;
	updatedAt?: number;
	lastAppliedSeq?: number;
	parts?: Array<{
		id: string;
		type: "text" | "thinking" | "tool";
		text?: string;
		sortOrder?: number;
	}>;
}

export interface TurnSeedOpts {
	state?: "pending" | "running" | "completed" | "interrupted" | "error";
	userMessageId?: string;
	assistantMessageId?: string;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	requestedAt?: number;
	startedAt?: number;
	completedAt?: number;
}

export interface TestHarness {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	seedSession: (id: string, opts?: SessionSeedOpts) => void;
	seedMessage: (id: string, sessionId: string, opts?: MessageSeedOpts) => void;
	seedTurn: (id: string, sessionId: string, opts?: TurnSeedOpts) => void;
	close: () => void;
}

export function createTestHarness(): TestHarness {
	const db = SqliteClient.memory();
	runMigrations(db, schemaMigrations);
	const eventStore = new EventStore(db);

	function seedSession(id: string, opts?: SessionSeedOpts): void {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		db.execute(
			`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				opts?.provider ?? "opencode",
				opts?.title ?? "Test Session",
				opts?.status ?? "idle",
				opts?.parentId ?? null,
				opts?.forkPointEvent ?? null,
				now,
				opts?.updatedAt ?? now,
			],
		);
	}

	function seedMessage(
		id: string,
		sessionId: string,
		opts?: MessageSeedOpts,
	): void {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		db.execute(
			`INSERT INTO messages (id, session_id, role, created_at, updated_at, last_applied_seq)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				id,
				sessionId,
				opts?.role ?? "assistant",
				now,
				opts?.updatedAt ?? now,
				opts?.lastAppliedSeq ?? 0,
			],
		);
		for (const [i, part] of (opts?.parts ?? []).entries()) {
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					part.id,
					id,
					part.type,
					part.text ?? "",
					part.sortOrder ?? i,
					now,
					now,
				],
			);
		}
	}

	function seedTurn(id: string, sessionId: string, opts?: TurnSeedOpts): void {
		const now = opts?.requestedAt ?? FIXED_TEST_TIMESTAMP;
		db.execute(
			`INSERT INTO turns (id, session_id, state, user_message_id, assistant_message_id, cost, tokens_in, tokens_out, requested_at, started_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				sessionId,
				opts?.state ?? "pending",
				opts?.userMessageId ?? null,
				opts?.assistantMessageId ?? null,
				opts?.cost ?? null,
				opts?.tokensIn ?? null,
				opts?.tokensOut ?? null,
				now,
				opts?.startedAt ?? null,
				opts?.completedAt ?? null,
			],
		);
	}

	return {
		db,
		eventStore,
		seedSession,
		seedMessage,
		seedTurn,
		close: () => db.close(),
	};
}
