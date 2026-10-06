import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Queue, Stream } from "effect";
import { expect } from "vitest";
import {
	type InputDraftEnvelope,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

// ni8.15: a composer draft typed in one tab reaches every other tab open on
// that session, and only that session, over a typed subscription.

const makeLayer = () =>
	WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer()));

const open = Effect.gen(function* () {
	const client = yield* RpcTest.makeClient(WsRpcGroup);
	const subscribe = (sessionId: string) =>
		Effect.gen(function* () {
			const q = yield* Queue.unbounded<InputDraftEnvelope>();
			yield* Stream.runForEach(
				client.SubscribeInputDraft({ projectSlug: "project", sessionId }),
				(envelope) => Queue.offer(q, envelope),
			).pipe(Effect.forkScoped);
			expect(yield* Queue.take(q)).toEqual({ _tag: "synchronized" });
			return q;
		});
	return { client, subscribe };
});

describe("SubscribeInputDraft", () => {
	it.scoped("a draft typed in one tab reaches every tab on that session", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const tabA = yield* subscribe("s1");
			const tabB = yield* subscribe("s1");
			const elsewhere = yield* subscribe("s2");

			yield* client.SyncInputDraft({
				projectSlug: "project",
				sessionId: "s1",
				text: "half a thought",
				originId: "tab-a",
			});

			for (const q of [tabA, tabB])
				expect(yield* Queue.take(q)).toEqual({
					_tag: "draft",
					text: "half a thought",
					from: "tab-a",
				});
			expect(Option.isNone(yield* Queue.poll(elsewhere))).toBe(true);
		}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped("a cleared draft reaches open tabs as empty text", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const q = yield* subscribe("s1");

			yield* client.SyncInputDraft({
				projectSlug: "project",
				sessionId: "s1",
				text: "",
			});

			expect(yield* Queue.take(q)).toEqual({ _tag: "draft", text: "" });
		}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped("opens live-only: an earlier draft is not replayed", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			yield* client.SyncInputDraft({
				projectSlug: "project",
				sessionId: "s1",
				text: "typed before the tab subscribed",
			});

			const q = yield* subscribe("s1");

			expect(Option.isNone(yield* Queue.poll(q))).toBe(true);
		}).pipe(Effect.provide(makeLayer())),
	);
});
