import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { afterEach, expect, vi } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { ResolveSession } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { HttpServerRefTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { resolveDaemonOpenCodeSession } from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionDirectoryLive,
	SessionDirectory,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";
import * as wsRpcHandler from "../../../src/lib/server/ws-rpc-handler.js";
import type { StoredProject } from "../../../src/lib/types.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

// Failure modes: a cold non-first project is missed; resolve reopens stores;
// writes publish ownership before commit or miss direct child/adoption writes;
// cascades leave stale ids; project removal keeps ids; OpenCode aliases hide
// ambiguous adoption when two projects share a folder.
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "session-directory-"));
	roots.push(root);
	const folder = join(root, "shared-folder");
	mkdirSync(folder);
	const projects: StoredProject[] = ["a", "b"].map((slug) => ({
		slug,
		title: slug,
		folders: [folder],
	}));
	for (const { slug } of projects) {
		const storage = projectStorageDir(root, slug);
		mkdirSync(storage, { recursive: true });
		writeEventStore(
			join(storage, "events.db"),
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, provider_sid, title, status, created_at, updated_at)
				VALUES (${`ses_${slug}`}, 'opencode', 'shared-provider-id', ${slug}, 'idle', 1, 1)`;
			}),
		);
	}
	return { root, projects };
}

it.scoped(
	"ResolveSession and AttachProject find a cold non-first project without opening stores",
	() => {
		const { root, projects } = fixture();
		return Effect.gen(function* () {
			const context = yield* Layer.build(
				makeSessionDirectoryLive(root, projects),
			);
			const directory = yield* SessionDirectory.pipe(Effect.provide(context));
			const attachFactory = vi.spyOn(
				wsRpcHandler,
				"makeRoutedWsRpcWebSocketHandler",
			);
			const daemon = makeDaemonRpcTestLayer(projects, undefined, {
				configDir: root,
			});
			const handlers = yield* DaemonWsRpcHandlersTag.pipe(
				Effect.provide(daemon),
				Effect.provideService(SessionDirectory, directory),
			);
			// A reopened database cannot contain sessions. Both stores are now absent.
			for (const { slug } of projects) {
				const filename = join(projectStorageDir(root, slug), "events.db");
				renameSync(filename, `${filename}.hidden`);
			}
			expect(
				yield* handlers.ResolveSession(
					new ResolveSession({ sessionId: "ses_b" }),
				),
			).toEqual({ projectSlug: "b" });
			expect(
				yield* Effect.either(
					handlers.ResolveSession(new ResolveSession({ sessionId: "missing" })),
				),
			).toMatchObject({ _tag: "Left", left: { _tag: "WsRpcError" } });
			yield* Layer.build(
				WebSocketRoutingLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							daemon,
							Layer.succeed(SessionDirectory, directory),
							Layer.effect(
								HttpServerRefTag,
								Ref.make<import("node:http").Server | null>(createServer()),
							),
							makeAuthManagerLive(new AuthManager({ getPinHash: () => null })),
							Layer.succeed(WebSocketRelayRouterTag, {
								ensureRelayStarted: () => Effect.void,
								waitForRelay: () => Effect.succeed({ rpcWsHandler: {} }),
								touchLastUsed: () => Effect.void,
							}),
						),
					),
				),
			);
			const attach = attachFactory.mock.calls.at(-1)?.[4];
			if (!attach) throw new Error("AttachProject handler missing");
			expect(
				yield* attach({ originId: "directory-test", sessionId: "ses_b" }),
			).toEqual({ projectSlug: "b", sessionSlug: "b" });
			expect(
				yield* Effect.either(
					attach({ originId: "directory-test", sessionId: "missing" }),
				),
			).toMatchObject({ _tag: "Left", left: { _tag: "WsRpcError" } });
		});
	},
);

it.scoped(
	"committed creates, direct child stamps and cascaded deletes keep the directory current",
	() =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				makeSessionDirectoryLive("/unused", []),
			);
			const directory = yield* SessionDirectory.pipe(Effect.provide(context));
			yield* Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"session.created",
						"parent",
						{ sessionId: "parent", title: "Parent", provider: "claude" },
						{ provider: "claude" },
					),
				]);
				expect(yield* directory.projectOf("parent")).toEqual(Option.some("b"));
				yield* commit.write((_project, stamp) =>
					stamp(() =>
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							yield* sql`INSERT INTO sessions (id, provider, title, status, parent_id, created_at, updated_at) VALUES ('child', 'claude', 'Child', 'idle', 'parent', 1, 1)`;
							return ["child"];
						}),
					),
				);
				expect(yield* directory.projectOf("child")).toEqual(Option.some("b"));
				yield* Effect.either(
					commit.write((_project, stamp) =>
						stamp(() =>
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('rolled-back', 'claude', 'Bad', 'idle', 1, 1)`;
								return ["rolled-back"];
							}),
						).pipe(Effect.andThen(Effect.fail("rollback"))),
					),
				);
				expect(yield* directory.projectOf("rolled-back")).toEqual(
					Option.none(),
				);
				yield* commit([
					canonicalEvent(
						"session.deleted",
						"parent",
						{ sessionId: "parent" },
						{ provider: "claude" },
					),
				]);
				expect(yield* directory.projectOf("parent")).toEqual(Option.none());
				expect(yield* directory.projectOf("child")).toEqual(Option.none());
				yield* commit([
					canonicalEvent(
						"session.created",
						"remaining",
						{ sessionId: "remaining", title: "Remaining", provider: "claude" },
						{ provider: "claude" },
					),
				]);
				yield* directory.removeProject("b");
				expect(yield* directory.projectOf("remaining")).toEqual(Option.none());
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "b")),
				Effect.provideService(SessionDirectory, directory),
			);
		}),
);

it.scoped(
	"OpenCode adoption by two projects sharing a folder is explicitly ambiguous",
	() => {
		const { root, projects } = fixture();
		return Effect.gen(function* () {
			const result = yield* Effect.either(
				resolveDaemonOpenCodeSession(root, "opencode", "shared-provider-id"),
			);
			expect(result).toMatchObject({
				_tag: "Left",
				left: {
					message: expect.stringContaining("more than one Conduit project"),
				},
			});
		}).pipe(Effect.provide(makeProjectRegistryLive(projects)));
	},
);
