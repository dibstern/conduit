// Failure modes: provider activity changes human recency; child activity rolls
// into the parent; old history is not backfilled; project metadata is lost on
// restart; order writes fail to reach another device or retain unknown slugs.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import Database from "better-sqlite3";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import type { ShellEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	defaultDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const subscribers: Fiber.Fiber<void, unknown>[] = [];
const proof: Record<string, unknown> = {};
const config = (fixture: ProcessHarness): DaemonConfig =>
	JSON.parse(readFileSync(join(fixture.configDir, "daemon.json"), "utf8"));

async function start(
	options: Parameters<typeof ProcessHarness.create>[0] = {},
) {
	const fixture = ProcessHarness.create(options);
	harness = fixture;
	await fixture.restart({ startupTimeoutMs: 30_000 });
	return fixture;
}

afterEach(async () => {
	for (const fiber of subscribers.splice(0))
		await Effect.runPromise(Fiber.interrupt(fiber));
	await harness?.dispose();
	harness = undefined;
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/m37941-project-tree-data.json",
		`${JSON.stringify(proof, null, 2)}\n`,
	);
});

async function watch(browser: ProcessBrowser) {
	const frames: ShellEnvelope[] = [];
	subscribers.push(
		Effect.runFork(
			browser.rpc
				.SubscribeShell({})
				.pipe(
					Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
				),
		),
	);
	await expect
		.poll(() => frames.some((frame) => frame._tag === "synchronized"))
		.toBe(true);
	return frames;
}

const projectsFrame = (frames: readonly ShellEnvelope[]) =>
	frames.filter((frame) => frame._tag === "projects").at(-1);

it("ignores live OpenCode compaction and synthetic text user rows", async () => {
	harness = await start({ managedOpenCode: true });
	const fixture = harness;
	const browser = await fixture.connect();
	const id = await browser.createSession(
		"Provider context",
		"managed-test",
		"opencode",
	);
	const frames = await watch(browser);
	await expect
		.poll(
			() =>
				fixture
					.opencodeStreamConnections()
					.some((connection) => connection.action === "open"),
			{ timeout: 5000 },
		)
		.toBe(true);
	const emit = (type: string, properties: Record<string, unknown>) =>
		fixture.emitOpenCodeEvent(
			{
				directory: realpathSync(fixture.projectDir),
				payload: { id: randomUUID(), type, properties },
			},
			"managed-test",
		);
	await emit("message.updated", {
		info: {
			id: "human-1",
			sessionID: id,
			role: "user",
			time: { created: Date.now() },
		},
	});
	await emit("message.part.updated", {
		part: {
			id: "human-part-1",
			messageID: "human-1",
			sessionID: id,
			type: "text",
			text: "Human prompt",
		},
	});
	await expect
		.poll(
			async () =>
				(await browser.history(id)).some((message) => message.id === "human-1"),
			{ timeout: 10_000 },
		)
		.toBe(true);
	const first = (await browser.history(id)).find(
		(message) => message.role === "user",
	)?.time?.created;
	expect(first).toBeTypeOf("number");
	for (const [messageID, part] of [
		["compaction-1", { type: "compaction", auto: true }],
		[
			"synthetic-1",
			{ type: "text", text: "Injected context", synthetic: true },
		],
	] as const) {
		await emit("message.updated", {
			info: {
				id: messageID,
				sessionID: id,
				role: "user",
				time: { created: Date.now() },
			},
		});
		await emit("message.part.updated", {
			part: { id: `${messageID}-part`, messageID, sessionID: id, ...part },
		});
		await expect
			.poll(
				async () =>
					(await browser.history(id)).some(
						(message) => message.id === messageID,
					),
				{ timeout: 5000 },
			)
			.toBe(true);
		const snapshot = (await watch(browser)).find(
			(frame) => frame._tag === "snapshot",
		);
		expect
			.soft(
				snapshot?.rows.find((row) => row.id === id)?.lastUserMessageAt,
				`${messageID} must not advance the clock`,
			)
			.toBe(first);
	}
	const live = frames
		.filter((frame) => frame._tag === "upsert")
		.filter((frame) => frame.item.id === id)
		.at(-1);
	expect.soft(live?.item.lastUserMessageAt).toBe(first);
	proof["syntheticRows"] = { session: 3, humanMessage: 1, ignoredRows: [2, 3] };
}, 90_000);

it("counts queued inputs only after delivery and counts delivered steers", async () => {
	harness = await start({ restartProof: true });
	const browser = await harness.connect();
	const id = await browser.createSession("Delivery recency");
	const frames = await watch(browser);
	const clock = () =>
		frames
			.flatMap((frame) =>
				frame._tag === "snapshot"
					? frame.rows
					: frame._tag === "upsert"
						? [frame.item]
						: [],
			)
			.filter((row) => row.id === id)
			.at(-1)?.lastUserMessageAt;
	expect(clock()).toBeUndefined();
	const running = browser.send(id, "upgrade-long-turn");
	void running.catch(() => undefined);
	await expect
		.poll(
			async () =>
				(await browser.history(id)).some(
					(message) =>
						message.role === "assistant" &&
						message.parts?.some(
							(part) => part.type === "text" && Boolean(part.text),
						),
				),
			{ timeout: 10_000 },
		)
		.toBe(true);
	const first = clock();
	expect(first).toBeTypeOf("number");
	const queued = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId: queued,
				delivery: "queue",
				text: "queued correction",
			}),
		),
	).toMatchObject({ ok: true });
	expect(
		(await browser.history(id)).filter((message) => message.role === "user"),
	).toHaveLength(1);
	expect(clock()).toBe(first);
	const steer = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId: steer,
				delivery: "steer",
				text: "steer correction",
			}),
		),
	).toMatchObject({ ok: true });
	writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
	await running;
	await expect
		.poll(
			async () =>
				(await browser.history(id)).filter((message) => message.role === "user")
					.length,
			{ timeout: 10_000 },
		)
		.toBe(3);
	const history = (await browser.history(id)).filter(
		(message) => message.role === "user",
	);
	await expect.poll(clock).toBe(history.at(-1)?.time?.created);
	expect(clock()).toBeGreaterThan(first ?? 0);
	proof["delivery"] = {
		session: 2,
		queuedWaited: true,
		deliveredInputs: history.map((_, index) => index + 1),
		steerCounted: true,
	};
}, 90_000);

it("delivers a session's human-message recency in snapshots and live rows", async () => {
	harness = await start();
	const browser = await harness.connect();
	const id = await browser.createSession("Human recency");
	await browser.send(id, "history-proof");
	const frames = await watch(browser);
	const snapshot = frames.find((frame) => frame._tag === "snapshot");
	const before = snapshot?.rows.find((row) => row.id === id)?.lastUserMessageAt;
	expect.soft(before, "snapshot has latest human message").toBeTypeOf("number");
	const cursor = frames.length;
	const pending = browser.send(id, "approval-proof");
	void pending.catch(() => undefined);
	const approval = await browser.waitFor(
		(message) => message["type"] === "permission_pending",
	);
	await browser.answerApproval(approval, "allow");
	await pending;
	await expect
		.poll(() =>
			frames
				.slice(cursor)
				.some((frame) => frame._tag === "upsert" && frame.item.id === id),
		)
		.toBe(true);
	const after = frames
		.filter((frame) => frame._tag === "upsert")
		.filter((frame) => frame.item.id === id)
		.at(-1)?.item.lastUserMessageAt;
	expect
		.soft(after, "live send advances human recency")
		.toBeGreaterThan(before ?? 0);
	const history = await browser.history(id);
	const humans = history.filter((message) => message.role === "user");
	expect(humans).toHaveLength(2);
	expect
		.soft(after, "tool results and assistant completion keep the human clock")
		.toBe(humans.at(-1)?.time?.created);
	proof["humanRecency"] = {
		session: 1,
		messageOrder: humans.map((_, index) => index + 1),
		snapshotPresent: typeof before === "number",
		liveAdvanced: typeof after === "number" && after > (before ?? 0),
		toolResultKeptHumanClock: after === humans.at(-1)?.time?.created,
	};
}, 90_000);

it("shares project order between devices, filters unknown slugs and persists removal", async () => {
	harness = await start();
	const a = await harness.connect();
	const b = await harness.connect();
	const frames = await watch(b);
	const folder = join(harness.root, "second");
	mkdirSync(folder);
	const { savedSlug } = await Effect.runPromise(
		a.rpc.SaveProject({ folders: [folder] }),
	);
	const order = [savedSlug, "unknown-project", "process-test"];
	await Effect.runPromise(a.rpc.SetProjectOrder({ projectOrder: order }));
	await expect
		.poll(() => projectsFrame(frames)?.projectOrder)
		.toEqual([savedSlug, "process-test"]);
	await expect
		.poll(() => harness && config(harness).projectOrder)
		.toEqual([savedSlug, "process-test"]);
	await harness.signal("SIGINT");
	await harness.restart({ startupTimeoutMs: 30_000 });
	const restored = await harness.connect();
	const restartedFrames = await watch(restored);
	expect(projectsFrame(restartedFrames)?.projectOrder).toEqual([
		savedSlug,
		"process-test",
	]);
	await Effect.runPromise(restored.rpc.RemoveProject({ slug: savedSlug }));
	await expect
		.poll(() => projectsFrame(restartedFrames)?.projectOrder)
		.toEqual(["process-test"]);
	await expect
		.poll(() => harness && config(harness).projectOrder)
		.toEqual(["process-test"]);
	proof["projectOrder"] = {
		devices: [1, 2],
		shared: [2, 1],
		restarted: [2, 1],
		afterRemoval: [1],
		unknownDropped: true,
	};
}, 90_000);

it("backfills old history and project addedAt once, including empty projects", async () => {
	harness = ProcessHarness.create();
	const empty = join(harness.root, "empty");
	mkdirSync(empty);
	writeFileSync(
		join(harness.configDir, "daemon.json"),
		JSON.stringify({
			...defaultDaemonConfig(),
			projects: [
				{
					path: harness.projectDir,
					folders: [harness.projectDir],
					slug: "process-test",
				},
				{ path: empty, folders: [empty], slug: "empty" },
			],
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			makeEffectSqlMigrator(
				Object.fromEntries(
					Object.entries(effectMigrationEntries).filter(
						([key]) => Number.parseInt(key, 10) <= 63,
					),
				),
			).pipe(
				Effect.provide(
					SqliteClient.layer({ filename: harness.daemonStorePath() }),
				),
			),
		),
	);
	const db = new Database(harness.daemonStorePath());
	try {
		db.prepare(
			"INSERT INTO sessions (id, provider, title, created_at, updated_at, project_id, root_id, parent_id) VALUES (?, 'claude', ?, ?, ?, 'process-test', 'history-1', ?)",
		).run("history-1", "History", 1000, 1000, null);
		db.prepare(
			"INSERT INTO sessions (id, provider, title, created_at, updated_at, project_id, root_id, parent_id) VALUES (?, 'claude', ?, ?, ?, 'process-test', 'history-1', ?)",
		).run("child-1", "Child", 1500, 5000, "history-1");
		const insert = db.prepare(
			"INSERT INTO messages (id, session_id, role, text, created_at, updated_at, rest_payload) VALUES (?, ?, 'user', ?, ?, ?, ?)",
		);
		insert.run("human-1", "history-1", "Human prompt", 2000, 2000, null);
		insert.run(
			"context-1",
			"history-1",
			"Injected context",
			3000,
			3000,
			JSON.stringify({
				role: "user",
				parts: [{ type: "text", text: "Injected context", synthetic: true }],
			}),
		);
		insert.run("child-human-1", "child-1", "Child prompt", 5000, 5000, null);
		db.exec(`INSERT INTO sessions (id, provider, created_at, updated_at, project_id, root_id,
			forked_from, fork_point_event, fork_point_message_id, fork_point_timestamp)
			VALUES ('fork-1', 'claude', 6000, 6000, 'process-test', 'fork-1',
			'history-1', 'human-1', 'human-1', 2000)`);
		insert.run("human-1_fork-1", "fork-1", "Human prompt", 2000, 2000, null);
		db.exec(
			"UPDATE messages SET input_id = 'copied-input-1' WHERE id = 'human-1_fork-1'",
		);
	} finally {
		db.close();
	}
	await harness.restart({ startupTimeoutMs: 30_000 });
	const browser = await harness.connect();
	const frames = await watch(browser);
	const snapshot = frames.find((frame) => frame._tag === "snapshot");
	expect
		.soft(
			snapshot?.rows.find((row) => row.id === "history-1")?.lastUserMessageAt,
		)
		.toBe(2000);
	expect(
		snapshot?.rows.find((row) => row.id === "fork-1")?.lastUserMessageAt,
	).toBeUndefined();
	const { projects } = await Effect.runPromise(browser.rpc.GetProjects({}));
	const old = projects.find((project) => project.slug === "process-test");
	const blank = projects.find((project) => project.slug === "empty");
	expect.soft(old?.addedAt).toBe(1000);
	expect.soft(blank?.addedAt).toBeTypeOf("number");
	const folder = join(harness.root, "new");
	mkdirSync(folder);
	const saved = await Effect.runPromise(
		browser.rpc.SaveProject({ folders: [folder] }),
	);
	const fresh = saved.projects.find(
		(project) => project.slug === saved.savedSlug,
	);
	expect.soft(fresh?.addedAt).toBeTypeOf("number");
	expect(blank?.addedAt).toBeGreaterThan(old?.addedAt ?? 0);
	expect(fresh?.addedAt).toBeGreaterThan(blank?.addedAt ?? 0);
	await expect.poll(() => harness && config(harness).projects.length).toBe(3);
	const dates = (
		projects: readonly { slug: string; addedAt?: number | undefined }[],
	) =>
		projects
			.map(({ slug, addedAt }) => ({ slug, addedAt }))
			.sort((a, b) => a.slug.localeCompare(b.slug));
	const before = dates(config(harness).projects);
	await harness.signal("SIGINT");
	await harness.restart({ startupTimeoutMs: 30_000 });
	const next = await harness.connect();
	const restarted = await watch(next);
	expect(dates(config(harness).projects)).toEqual(before);
	expect(dates(projectsFrame(restarted)?.projects ?? [])).toEqual(before);
	proof["backfill"] = {
		session: 1,
		lastHumanMessage: 1,
		syntheticExcluded: true,
		childExcluded: true,
		projectAddedOrder: [1, 2, 3],
		stableAcrossRestart: true,
	};
}, 90_000);
