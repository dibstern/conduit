import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	type InputDraftEnvelope,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { InputDraftsTag } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import { inputDraftClaimMarker } from "../../../src/lib/persistence/input-drafts.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

// ni8.15: a composer draft typed in one tab reaches every other tab open on
// that session, and only that session, over a typed subscription.

const makeLayer = () =>
	WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer()));

const open = Effect.gen(function* () {
	const client = yield* RpcTest.makeClient(WsRpcGroup);
	const subscribe = (sessionId: string, text?: string) =>
		Effect.gen(function* () {
			const q = yield* Queue.unbounded<InputDraftEnvelope>();
			yield* Stream.runForEach(
				client.SubscribeInputDraft({ key: { session: sessionId } }),
				(envelope) => Queue.offer(q, envelope),
			).pipe(Effect.forkScoped);
			expect(yield* Queue.take(q)).toEqual({
				_tag: "synchronized",
				attachments: [],
				...(text === undefined ? {} : { text }),
			});
			return q;
		});
	return { client, subscribe };
});

describe("SubscribeInputDraft", () => {
	it.effect("an unclaimed promotion writes and publishes nothing", () =>
		Effect.gen(function* () {
			const drafts = yield* InputDraftsTag;
			const sql = yield* SqlClient.SqlClient;
			const key = { draft: "unclaimed" };
			yield* drafts.write(key, "keep", undefined, "test-project");
			const queue = yield* Queue.unbounded<InputDraftEnvelope>();
			yield* Stream.runForEach(drafts.subscribe(key), (envelope) =>
				Queue.offer(queue, envelope),
			).pipe(Effect.forkScoped);
			yield* Queue.take(queue);
			const change = drafts.promotionChange(key, "missing-session", "keep");
			yield* sql.withTransaction(change.write);
			yield* change.publish;
			expect(yield* drafts.read(key)).toBe("keep");
			expect(Option.isNone(yield* Queue.poll(queue))).toBe(true);
		}).pipe(Effect.provide(makeLayer(), { local: true })),
	);

	it.effect(
		"demotion restores text and all attachment states before deletion, releases and retries",
		() =>
			Effect.gen(function* () {
				const drafts = yield* InputDraftsTag;
				const sql = yield* SqlClient.SqlClient;
				const key = { draft: "retry-draft" };
				yield* drafts.write(key, "original text", undefined, "test-project");
				yield* drafts.addAttachment(
					key,
					"live",
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
					"image.png",
					"test-project",
				);
				yield* drafts.removeAttachment(key, "removed", "test-project");
				yield* sql`INSERT INTO draft_attachments (id, draft_key, position, state, created_at) VALUES ('sent', 'retry-draft', 2, 'sent', 1)`;
				const before =
					yield* sql`SELECT * FROM draft_attachments WHERE draft_key = 'retry-draft' ORDER BY id`;
				yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('created', 'test-project', 'claude', 'Session', 'idle', 1, 1)`;
				expect(yield* drafts.claim(key.draft, "test-project")).toBe(true);
				yield* sql.withTransaction(
					drafts.promotionChange(key, "created", "original text").write,
				);
				yield* drafts.demote(key, "created");
				expect(
					yield* sql`SELECT text, promoted_session_id FROM input_drafts WHERE draft_key = 'retry-draft'`,
				).toEqual([
					{ text: "original text", promoted_session_id: inputDraftClaimMarker },
				]);
				expect(
					yield* sql`SELECT draft_key FROM input_drafts WHERE draft_key = 'created'`,
				).toEqual([]);
				yield* sql`DELETE FROM sessions WHERE id = 'created'`;
				yield* drafts.releaseClaim(key.draft);
				expect(
					yield* sql`SELECT * FROM draft_attachments WHERE draft_key = 'retry-draft' ORDER BY id`,
				).toEqual(before);
				expect(
					Option.getOrThrow(yield* drafts.listDrafts().pipe(Stream.runHead)),
				).toMatchObject([
					{ draftId: key.draft, firstLine: "original text", imageCount: 1 },
				]);
				expect(yield* drafts.claim(key.draft, "test-project")).toBe(true);
				yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('retry', 'test-project', 'claude', 'Session', 'idle', 1, 1)`;
				yield* sql.withTransaction(
					drafts.promotionChange(key, "retry", "original text").write,
				);
				expect(yield* drafts.read({ session: "retry" })).toBe("original text");
				expect(
					yield* drafts.takeForSend({ session: "retry" }, ["live"]),
				).toMatchObject([{ name: "image.png" }]);
			}).pipe(Effect.provide(makeLayer(), { local: true })),
	);

	it.effect("EA22 ownership lookup errors reach the RPC client", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client
				.SubscribeInputDraft({ key: { session: "unreadable" } })
				.pipe(Stream.runHead, Effect.result);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "WsRpcError", code: "ownership-lookup-failed" },
			});
		}).pipe(
			Effect.provideService(SessionDirectory, {
				projectOf: (sessionId) =>
					Effect.fail(
						new SessionDirectoryReadError({ sessionId, cause: "unavailable" }),
					),
			}),
			Effect.provide(makeLayer(), { local: true }),
		),
	);
	it.effect("a draft typed in one tab reaches every tab on that session", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'test-project', 'opencode', 'Session 1', 'idle', 1, 1),
				       ('s2', 'test-project', 'opencode', 'Session 2', 'idle', 1, 1)`;
			const tabA = yield* subscribe("s1");
			const tabB = yield* subscribe("s1");
			const elsewhere = yield* subscribe("s2");

			yield* client.SyncInputDraft({
				key: { session: "s1" },
				text: "half a thought",
				originId: "tab-a",
			});

			for (const q of [tabA, tabB])
				expect(yield* Queue.take(q)).toEqual({
					_tag: "draft",
					attachments: [],
					text: "half a thought",
					from: "tab-a",
				});
			expect(Option.isNone(yield* Queue.poll(elsewhere))).toBe(true);
		}).pipe(Effect.provide(makeLayer(), { local: true })),
	);

	it.effect("a cleared draft reaches open tabs as empty text", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'test-project', 'opencode', 'Session', 'idle', 1, 1)`;
			const q = yield* subscribe("s1");

			yield* client.SyncInputDraft({
				key: { session: "s1" },
				text: "",
			});

			expect(yield* Queue.take(q)).toEqual({
				_tag: "draft",
				attachments: [],
				text: "",
			});
		}).pipe(Effect.provide(makeLayer(), { local: true })),
	);

	it.effect("opens with the stored draft before following live changes", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'test-project', 'opencode', 'Session', 'idle', 1, 1)`;
			yield* client.SyncInputDraft({
				key: { session: "s1" },
				text: "typed before the tab subscribed",
			});

			const q = yield* subscribe("s1", "typed before the tab subscribed");

			expect(Option.isNone(yield* Queue.poll(q))).toBe(true);
		}).pipe(Effect.provide(makeLayer(), { local: true })),
	);
});
