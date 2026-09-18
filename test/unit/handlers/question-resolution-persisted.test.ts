// An answered question has to stop being pending in the read model too.
//
// The badge counts unresolved questions out of `pending_approvals`. Before
// ni8.23 delta 1 the OpenCode answer paths only broadcast `ask_user_resolved`:
// the card disappeared for the browser that answered, the row stayed pending,
// and every reload — and every other tab — showed the session still asking.
//
// These drive the real handlers against a real store and assert the durable
// fact, plus the advance that tells a subscriber to go and read it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	type OverridesStateTag,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	handleAskUserResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OpenCodeRuntimeEventTranslator } from "../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../src/lib/provider/provider-runtime-event-to-domain.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

const SESSION = "session-1";
const QUESTION = "que-1";

const makeWsHandler = () => ({
	broadcast: vi.fn(),
	sendTo: vi.fn(),
	setClientSession: vi.fn(),
	getClientSession: vi.fn(() => SESSION),
	getClientsForSession: vi.fn(() => ["client-1"]),
	sendToSession: vi.fn(),
	broadcastPerSessionEvent: vi.fn(),
	markClientBootstrapped: vi.fn(),
	getClientCount: vi.fn(() => 1),
	getClientIds: vi.fn(() => ["client-1"]),
	handleUpgrade: vi.fn(),
	close: vi.fn(),
	drain: vi.fn(async () => undefined),
	on: vi.fn(),
	once: vi.fn(),
});

/**
 * A live store and bus behind the real handler layer, so the assertion is on
 * what survives the handler rather than on what it was asked to do.
 */
/** Everything the handlers under test reach for; all of it is in `layer`. */
type HandlerStack =
	| PersistenceEffectContext
	| SessionEventBusTag
	| OpenCodeAPITag
	| WebSocketHandlerTag
	| LoggerTag
	| SessionManagerServiceTag
	| OverridesStateTag;

const withHandlerStack = async (
	client: OpenCodeAPI,
	body: (ctx: {
		readonly advances: ReadModelAdvance[];
		readonly pendingQuestions: Effect.Effect<
			number,
			unknown,
			SqlClient.SqlClient
		>;
	}) => Effect.Effect<void, unknown, HandlerStack>,
): Promise<void> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-question-resolved-"));
	const advances: ReadModelAdvance[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		createAllEffectProjectors(),
		bus,
	);
	const layer = Layer.mergeAll(
		persistence,
		bus,
		Layer.succeed(OpenCodeAPITag, client),
		Layer.succeed(WebSocketHandlerTag, makeWsHandler()),
		Layer.succeed(LoggerTag, createSilentLogger()),
		Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
		makeOverridesStateLive(),
	);

	const pendingQuestions = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			n: number;
		}>`SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ${SESSION} AND type = 'question' AND status = 'pending'`;
		return rows[0]?.n ?? 0;
	});

	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", SESSION, {
						sessionId: SESSION,
						title: SESSION,
						provider: "opencode",
					}),
					canonicalEvent("question.asked", SESSION, {
						id: QUESTION,
						sessionId: SESSION,
						questions: [{ text: "which?" }],
					}),
				]);
				expect(yield* pendingQuestions).toBe(1);
				advances.length = 0;

				yield* body({ advances, pendingQuestions });
			}).pipe(Effect.provide(layer), Effect.orDie),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

it("answering an OpenCode question resolves the row and announces the advance", async () => {
	const client = {
		question: { reply: vi.fn(async () => undefined) },
	} as unknown as OpenCodeAPI;

	await withHandlerStack(client, ({ advances, pendingQuestions }) =>
		Effect.gen(function* () {
			yield* handleAskUserResponse("client-1", {
				toolId: QUESTION,
				answers: { "0": "Yes" },
			});

			expect(yield* pendingQuestions).toBe(0);

			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				version: number;
			}>`SELECT version FROM sessions WHERE id = ${SESSION}`;
			expect(advances.at(-1)).toEqual({
				version: rows[0]?.version,
				sessionIds: [SESSION],
			});
		}),
	);
});

it("skipping an OpenCode question resolves the row and announces the advance", async () => {
	const client = {
		question: { reject: vi.fn(async () => undefined) },
	} as unknown as OpenCodeAPI;

	await withHandlerStack(client, ({ advances, pendingQuestions }) =>
		Effect.gen(function* () {
			yield* handleQuestionReject("client-1", { toolId: QUESTION });

			expect(yield* pendingQuestions).toBe(0);

			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				version: number;
			}>`SELECT version FROM sessions WHERE id = ${SESSION}`;
			expect(advances.at(-1)).toEqual({
				version: rows[0]?.version,
				sessionIds: [SESSION],
			});
		}),
	);
});

it("the recovery path resolves the question it actually replied to", async () => {
	// The direct reply fails and the handler falls back to whatever OpenCode
	// still has pending. The durable resolution has to name that id, not the one
	// the browser sent, or the row it clears is the wrong one.
	const client = {
		question: {
			reply: vi
				.fn()
				.mockRejectedValueOnce(new Error("no such question"))
				.mockResolvedValue(undefined),
			list: vi.fn(async () => [
				{ id: "other-session-question", sessionID: "other-session" },
				{ id: QUESTION, sessionID: SESSION },
			]),
		},
	} as unknown as OpenCodeAPI;

	await withHandlerStack(client, ({ pendingQuestions }) =>
		Effect.gen(function* () {
			yield* handleAskUserResponse("client-1", {
				toolId: "stale-id",
				answers: { "0": "Yes" },
			});

			expect(yield* pendingQuestions).toBe(0);
		}),
	);
});

it.each([
	"question.replied",
	"question.rejected",
])("an external %s clears the durable question and publishes its session", async (type) => {
	await withHandlerStack({} as OpenCodeAPI, ({ advances, pendingQuestions }) =>
		Effect.gen(function* () {
			const translator = new OpenCodeRuntimeEventTranslator();
			const events =
				translator.translate(
					{
						type,
						properties: {
							sessionID: SESSION,
							requestID: QUESTION,
							answers: [["Yes"]],
						},
					},
					SESSION,
				) ?? [];
			const commit = yield* makeCommitAndSignal;
			for (const event of events) {
				yield* commit(
					translateProviderRuntimeEventToDomain(
						event,
						emptyProviderRuntimeDomainMapperState,
					).events,
				);
			}
			expect(yield* pendingQuestions).toBe(0);
			expect(advances.at(-1)?.sessionIds).toEqual([SESSION]);
		}),
	);
});
