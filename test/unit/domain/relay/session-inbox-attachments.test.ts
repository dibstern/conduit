// Failure modes: a queued handoff without a provider/model leaves no message;
// fallback placement consumes files without storing them; the queue fails to pause.

import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { AttachmentStoreTag } from "../../../../src/lib/domain/persistence/Services/attachment-store.js";
import { ContinuationTag } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionEventBusTag } from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../../src/lib/persistence/session-history-adapter.js";
import { makeTestHandlerLayer } from "../../../helpers/mock-factories.js";

it("retains files in history when queued dispatch cannot place the input and pauses the remaining queue", async () => {
	const sendTurn = vi.fn(() => Effect.void);
	const images = [
		"data:text/plain;name=notes.txt;base64,Y2Fmw6k=",
		"data:application/pdf;name=guide.pdf;base64,JVBERi0xLjQ=",
	];
	const deps = Layer.mergeAll(
		makeTestHandlerLayer({
			persistenceLayer: makePersistenceEffectLayer(":memory:", "test-project"),
		}),
		Layer.succeed(SessionEventBusTag, {
			publish: () => Effect.void,
			publishAdvance: () => Effect.void,
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.empty),
		}),
		Layer.succeed(Usage, {
			readings: Stream.empty,
			latest: () => Effect.succeed(undefined),
			refresh: (_options) => Effect.succeed([]),
			turnEnded: () => Effect.void,
			pickFailover: () => Effect.succeed(undefined),
		}),
		Layer.succeed(ContinuationTag, {
			requestContinuation: () => Effect.void,
			intakeLimit: () => Effect.succeed(false),
			dismissCutOff: () => Effect.void,
			cancelContinuation: () => Effect.void,
			sweepDueContinuations: () => Effect.void,
			queueLimitPolicy: () => Effect.void,
			runLimitPolicies: Effect.never,
		}),
		Layer.succeed(ProviderTurnServiceTag, {
			holdUserTurnsForAccountSwitch: () => Effect.void,
			prepareTurnSession: () => Effect.succeed("opencode"),
			turnFences: () => ({ stopping: false, switching: false }),
			fenceLifts: Effect.succeed(Stream.never),
			beginStop: () => Effect.succeed(Effect.void),
			sendTurn,
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const inbox = yield* SessionInboxTag;
				const read = yield* ReadQueryEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				const refs = yield* Effect.forEach(images, (image) => store.put(image));
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						title: "Files",
						provider: "opencode",
					}),
					...["files", "next"].map((inputId) =>
						canonicalEvent("input.admitted", "session", {
							sessionId: "session",
							inputId,
							delivery: "queue",
							request:
								inputId === "files"
									? { text: "", images: refs }
									: { text: "wait" },
						}),
					),
				]);
				expect(
					yield* inbox.sendNow({
						clientId: "client",
						sessionId: "session",
						inputId: "files",
					}),
				).toBe("accepted");
				const rows = yield* read.getSessionMessagesWithParts("session");
				const history = messageRowsToHistory(rows, { pageSize: 20 });
				const users = history.messages.filter(({ role }) => role === "user");
				expect(users).toHaveLength(1);
				expect(
					users[0]?.parts?.map(({ filename, mime, source }) => ({
						filename,
						mime,
						source,
					})),
				).toEqual([
					{ filename: "notes.txt", mime: "text/plain", source: refs[0] },
					{ filename: "guide.pdf", mime: "application/pdf", source: refs[1] },
				]);
				expect(
					yield* sql`SELECT input_id FROM pending_inputs WHERE state = 'queued'`,
				).toEqual([{ input_id: "next" }]);
				expect(yield* sql`SELECT state FROM turns`).toEqual([
					{ state: "error" },
				]);
				yield* inbox.start;
				expect(sendTurn).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(SessionInboxLive.pipe(Layer.provideMerge(deps)))),
		),
	);
});
