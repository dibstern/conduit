// Failure modes: subscribing starts cold relays; rows acquire another project's
// decoration; per-project cursors reorder updates; child changes miss their root;
// resume loses deletions or trusts another membership/store; project changes
// miss a rebase or turn retained history into deletion; blocked imports leak rows;
// archived families stay visible or fail to return after restore.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import {
	Effect,
	Fiber,
	HashMap,
	Layer,
	ManagedRuntime,
	PubSub,
	Ref,
	Stream,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ShellEnvelope,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { DaemonStoreAvailability } from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import { ProjectRegistryTag } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { markUnread } from "../../../src/lib/domain/relay/Services/session-attention.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../src/lib/persistence/effect/live.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const created = (id: string, parentId?: string) =>
	canonicalEvent(
		"session.created",
		id,
		{
			sessionId: id,
			title: id,
			provider: "claude",
			...(parentId === undefined ? {} : { parentId }),
		},
		{ provider: "claude" },
	);

async function fixture(initial = ["alpha", "beta"]) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "conduit-shell-feed-")));
	const projects = ["alpha", "beta", "gamma"].map((slug) => {
		const folder = join(root, slug);
		mkdirSync(folder);
		return { slug, title: slug, folders: [folder] as const };
	});
	const blocked = new Map<string, string>();
	const factory = vi.fn(() =>
		Effect.die("Shell subscriptions must not acquire a relay"),
	);
	const runtime = ManagedRuntime.make(
		makeDaemonRpcTestLayer(
			projects.filter(({ slug }) => initial.includes(slug)),
			factory,
			{ configDir: root },
		).pipe(Layer.provide(Layer.succeed(DaemonStoreAvailability, blocked))),
	);
	cleanup.push(async () => {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const handlers = await runtime.runPromise(DaemonWsRpcHandlersTag);
	const route = vi.fn((_slug: string) =>
		Effect.die("Shell must not resolve a project"),
	);
	const store = await runtime.runPromise(PersistenceStore);
	const bus = await runtime.runPromise(SessionEventBusTag);
	const projectLayer = (slug: string) =>
		makePersistenceProjectLayer(slug, {
			sessionEventBusLayer: Layer.succeed(SessionEventBusTag, bus),
		}).pipe(
			Layer.provideMerge(Layer.succeedContext(store)),
			Layer.provideMerge(Layer.succeed(SessionEventBusTag, bus)),
		);
	const write = (slug: string, events: readonly CanonicalEvent[]) =>
		Effect.runPromise(
			Effect.flatMap(makeCommitAndSignal, (commit) => commit(events)).pipe(
				Effect.provide(projectLayer(slug)),
			),
		);
	const version = (id: string) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return (yield* sql<{
					version: number;
				}>`SELECT version FROM session_sidebar WHERE session_id = ${id}`)[0]
					?.version;
			}).pipe(Effect.provide(store)),
		);
	const count = () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return (yield* sql<{
					count: number;
				}>`SELECT COUNT(*) AS count FROM sessions`)[0]?.count;
			}).pipe(Effect.provide(store)),
		);
	const notify = () =>
		runtime.runPromise(
			Effect.flatMap(DaemonEventBusTag, (events) =>
				PubSub.publish(events, DaemonEvent.ProjectsChanged()),
			),
		);
	const membership = async (slugs: string[]) => {
		await runtime.runPromise(
			Effect.flatMap(ProjectRegistryTag, (registry) =>
				Ref.set(
					registry,
					HashMap.fromIterable(
						projects
							.filter(({ slug }) => slugs.includes(slug))
							.map(
								(project) =>
									[
										project.slug,
										{ _tag: "Registering" as const, project },
									] as const,
							),
					),
				),
			),
		);
		await notify();
	};
	const open = async (
		request: Parameters<typeof handlers.SubscribeShell>[0] = {},
	) => {
		const frames: ShellEnvelope[] = [];
		const fiber = runtime.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
						Effect.provide(makeRoutedWsRpcServerLayer(route, handlers)),
					);
					yield* client.SubscribeShell(request).pipe(
						Stream.runForEach((frame) =>
							Effect.sync(() => {
								frames.push(frame);
							}),
						),
					);
				}),
			),
		);
		const close = () => Effect.runPromise(Fiber.interrupt(fiber));
		await vi.waitFor(
			() =>
				expect(frames.some((frame) => frame._tag === "synchronized")).toBe(
					true,
				),
			{ timeout: 5000 },
		);
		return { frames, close };
	};
	return {
		root,
		runtime,
		handlers,
		blocked,
		factory,
		route,
		write,
		version,
		count,
		notify,
		membership,
		open,
		projectLayer,
	};
}

type Snapshot = Extract<ShellEnvelope, { readonly _tag: "snapshot" }>;
const snapshot = (frames: readonly ShellEnvelope[]): Snapshot => {
	const value = [...frames]
		.reverse()
		.find((frame): frame is Snapshot => frame._tag === "snapshot");
	if (!value) throw new Error("Missing shell snapshot");
	return value;
};
const upserts = (frames: readonly ShellEnvelope[]) =>
	frames.filter((frame) => frame._tag === "upsert");
const waitUpsert = async (
	frames: readonly ShellEnvelope[],
	id: string,
	after = 0,
) => {
	await vi.waitFor(
		() =>
			expect(
				upserts(frames.slice(after)).some(({ item }) => item.id === id),
			).toBe(true),
		{ timeout: 5000 },
	);
	return upserts(frames.slice(after)).find(({ item }) => item.id === id);
};

describe("daemon-wide shell feed", () => {
	it("serves the standalone shell without a project payload", async () => {
		const harness = await createRelayHarness();
		try {
			const client = await harness.connectWsClient();
			const projects = await client.waitFor("shell", {
				predicate: (message) => message["_tag"] === "projects",
			});
			expect(projects).toMatchObject({
				projects: [{ slug: "integration-test" }],
			});
			await client.close();
		} finally {
			await harness.stop();
		}
	});

	it("reads cold projects and orders interleaved project and child updates by row version", async () => {
		const f = await fixture();
		await f.write("alpha", [created("a"), created("a-child", "a")]);
		await f.write("beta", [created("b")]);
		const feed = await f.open();
		expect(feed.frames[0]).toMatchObject({
			_tag: "projects",
			projects: [{ slug: "alpha" }, { slug: "beta" }],
		});
		expect(
			snapshot(feed.frames)
				.rows.map(({ id, projectSlug }) => [id, projectSlug])
				.sort(),
		).toEqual([
			["a", "alpha"],
			["b", "beta"],
		]);
		const sequences: number[] = [];
		for (const [project, id] of [
			["alpha", "a"],
			["beta", "b"],
			["alpha", "a"],
		] as const) {
			const after = feed.frames.length;
			await f.write(project, [
				canonicalEvent("session.renamed", id, {
					sessionId: id,
					title: `${id}-${after}`,
				}),
			]);
			const update = await waitUpsert(feed.frames, id, after);
			expect(update).toMatchObject({
				item: { projectSlug: project },
				sequence: await f.version(id),
			});
			if (update) sequences.push(update.sequence);
		}
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(3);
		let after = feed.frames.length;
		await f.write("alpha", [
			canonicalEvent("session.status", "a-child", {
				sessionId: "a-child",
				status: "busy",
			}),
		]);
		expect(await waitUpsert(feed.frames, "a", after)).toMatchObject({
			item: { projectSlug: "alpha", attention: "working" },
		});
		expect(upserts(feed.frames).some(({ item }) => item.id === "a-child")).toBe(
			false,
		);
		// A row-only write advances the feed without appending an event.
		after = feed.frames.length;
		await Effect.runPromise(
			markUnread("b").pipe(Effect.provide(f.projectLayer("beta"))),
		);
		expect(await waitUpsert(feed.frames, "b", after)).toMatchObject({
			sequence: await f.version("b"),
		});
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.route).not.toHaveBeenCalled();
		await feed.close();
	});

	it("resumes covered deletions and rejects points from another store or membership", async () => {
		const f = await fixture();
		await f.write("alpha", [created("a"), created("spare-a")]);
		await f.write("beta", [created("b"), created("spare-b")]);
		const first = await f.open();
		const base = snapshot(first.frames);
		expect(base.resumePoint).toBeDefined();
		await first.close();
		await f.write("alpha", [
			canonicalEvent("session.deleted", "a", { sessionId: "a" }),
		]);
		const request = {
			resumeFromSequence: base.sequence,
			resumePoint: base.resumePoint,
		};
		const resumed = await f.open(request);
		expect(resumed.frames[0]?._tag).toBe("projects");
		expect(resumed.frames.some(({ _tag }) => _tag === "snapshot")).toBe(false);
		expect(resumed.frames).toContainEqual({
			_tag: "remove",
			id: "a",
			sequence: await f.version("a"),
			deleted: true,
		});
		await resumed.close();
		await f.membership(["beta"]);
		const changed = await f.open(request);
		expect(
			snapshot(changed.frames)
				.rows.map(({ id }) => id)
				.sort(),
		).toEqual(["b", "spare-b"]);
		await changed.close();
		const other = await fixture();
		const foreign = await other.open(request);
		expect(snapshot(foreign.frames).rows).toEqual([]);
		await foreign.close();
	});

	it("rebases add, remove, re-add and zero projects without deleting retained sessions", async () => {
		const f = await fixture(["alpha"]);
		await f.write("alpha", [created("a")]);
		await f.write("beta", [created("b")]);
		const feed = await f.open();
		const originalVersion = snapshot(feed.frames).sequence;
		for (const [slugs, ids] of [
			[
				["alpha", "beta"],
				["a", "b"],
			],
			[["alpha"], ["a"]],
			[
				["alpha", "beta"],
				["a", "b"],
			],
			[[], []],
		] as const) {
			const after = feed.frames.length;
			await f.membership([...slugs]);
			await vi.waitFor(
				() =>
					expect(
						feed.frames
							.slice(after)
							.some(({ _tag }) => _tag === "synchronized"),
					).toBe(true),
				{ timeout: 5000 },
			);
			expect(
				feed.frames.slice(after, after + 2).map(({ _tag }) => _tag),
			).toEqual(["projects", "snapshot"]);
			expect(
				snapshot(feed.frames)
					.rows.map(({ id }) => id)
					.sort(),
			).toEqual([...ids]);
			expect(snapshot(feed.frames).sequence).toBe(originalVersion);
		}
		expect(
			feed.frames.some((frame) => frame._tag === "remove" && frame.deleted),
		).toBe(false);
		expect(await f.count()).toBe(2);
		expect(f.factory).not.toHaveBeenCalled();
		await feed.close();
	});

	it("sends metadata-only project frames without replacing session rows", async () => {
		const f = await fixture();
		await f.write("alpha", [created("a")]);
		const feed = await f.open();
		const after = feed.frames.length;
		await f.runtime.runPromise(
			Effect.flatMap(DaemonConfigRefTag, (config) =>
				Ref.update(config, (value) => ({
					...value,
					newSessionProject: "beta",
				})),
			),
		);
		await f.notify();
		await vi.waitFor(() => expect(feed.frames.slice(after)).toHaveLength(1), {
			timeout: 5000,
		});
		expect(feed.frames[after]).toMatchObject({
			_tag: "projects",
			newSessionProject: "beta",
		});
		const boundary = feed.frames.length;
		await f.write("alpha", [
			canonicalEvent("session.renamed", "a", {
				sessionId: "a",
				title: "After metadata",
			}),
		]);
		await waitUpsert(feed.frames, "a", boundary);
		expect(
			feed.frames.slice(after).filter(({ _tag }) => _tag === "snapshot"),
		).toEqual([]);
		await feed.close();
	});

	it("isolates blocked imports and rebases when their availability changes", async () => {
		const f = await fixture();
		await f.write("alpha", [created("a")]);
		await f.write("beta", [created("b")]);
		f.blocked.set("beta", "History import failed");
		const feed = await f.open();
		expect(feed.frames[0]).toMatchObject({
			_tag: "projects",
			projects: [
				{ slug: "alpha" },
				{ slug: "beta", unavailableReason: "History import failed" },
			],
		});
		expect(snapshot(feed.frames).rows.map(({ id }) => id)).toEqual(["a"]);
		const after = feed.frames.length;
		f.blocked.clear();
		await f.notify();
		await vi.waitFor(
			() =>
				expect(
					feed.frames.slice(after).some(({ _tag }) => _tag === "snapshot"),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(feed.frames.slice(after, after + 2).map(({ _tag }) => _tag)).toEqual(
			["projects", "snapshot"],
		);
		expect(
			snapshot(feed.frames)
				.rows.map(({ id }) => id)
				.sort(),
		).toEqual(["a", "b"]);
		expect(f.factory).not.toHaveBeenCalled();
		await feed.close();
	});

	it("hides archived families and re-sends them when restored", async () => {
		const f = await fixture();
		await f.write("alpha", [
			created("a"),
			created("child", "a"),
			canonicalEvent("session.archived", "a", {
				sessionId: "a",
				automatic: false,
			}),
		]);
		await f.write("beta", [created("b")]);
		const feed = await f.open();
		expect(snapshot(feed.frames).rows.map(({ id }) => id)).toEqual(["b"]);
		let after = feed.frames.length;
		await f.write("alpha", [
			canonicalEvent("session.unarchived", "a", {
				sessionId: "a",
				cause: "manual",
			}),
		]);
		expect(await waitUpsert(feed.frames, "a", after)).toMatchObject({
			item: { projectSlug: "alpha" },
		});
		after = feed.frames.length;
		await f.write("alpha", [
			canonicalEvent("session.archived", "a", {
				sessionId: "a",
				automatic: false,
			}),
		]);
		await vi.waitFor(
			() =>
				expect(
					feed.frames
						.slice(after)
						.some((frame) => frame._tag === "remove" && frame.id === "a"),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(
			feed.frames.slice(after).find((frame) => frame._tag === "remove"),
		).not.toHaveProperty("deleted", true);
		expect(await f.count()).toBe(3);
		await feed.close();
	});
});
