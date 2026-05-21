// Integration test: RelayEventSink -> Effect persistence -> SQLite read query
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import {
	makeMessageCreatedEvent,
	makeTextDelta,
} from "../../helpers/persistence-factories.js";
import { providerRuntimeEventFromCanonical } from "../../helpers/provider-runtime-event.js";

describe("RelayEventSink Effect persistence integration", () => {
	it.effect(
		"persisted Claude events are readable through ReadQueryEffect",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-sink-effect-"));
			const layer = makePersistenceEffectLayer(join(dir, "events.db"));

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const send = vi.fn();
				const sink = createRelayEventSink({
					sessionId: "s1",
					send,
					persist,
				});

				yield* sink.push(
					providerRuntimeEventFromCanonical(
						makeMessageCreatedEvent("s1", "m1", {
							role: "assistant",
						}),
					),
				);
				yield* sink.push(
					providerRuntimeEventFromCanonical(
						makeTextDelta("s1", "m1", "Hello from Claude"),
					),
				);

				const messages = yield* readQuery.getSessionMessagesWithParts("s1");
				expect(messages.length).toBeGreaterThanOrEqual(1);
				expect(messages.find((m) => m.role === "assistant")).toBeDefined();
				expect(send).toHaveBeenCalled();
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect("creates the session row with provider claude", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-sink-effect-"));
		const layer = makePersistenceEffectLayer(join(dir, "events.db"));

		return Effect.gen(function* () {
			const persist = yield* ClaudeEventPersistEffectTag;
			const readQuery = yield* ReadQueryEffectTag;
			const send = vi.fn();
			const sink = createRelayEventSink({
				sessionId: "s-claude",
				send,
				persist,
			});

			yield* sink.push(
				providerRuntimeEventFromCanonical(
					makeMessageCreatedEvent("s-claude", "m1", { role: "assistant" }),
				),
			);

			const sessions = yield* readQuery.listSessions();
			expect(sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "s-claude",
						provider: "claude",
					}),
				]),
			);
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		);
	});
});
