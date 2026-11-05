// One retention scheduler per daemon (82tn.16): it reclaims the deleted sessions of every registered
// project, including one no tab has opened since a restart, and none of a project no longer registered.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { EventRetentionSchedulerTag } from "../../../src/lib/domain/persistence/Services/event-retention-scheduler.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceStoreLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

let harness: DaemonProject | undefined;
const cleanup: (() => void)[] = [];
afterEach(async () => {
	await harness?.stop();
	harness = undefined;
	vi.restoreAllMocks();
	for (const dispose of cleanup.splice(0)) dispose();
});

it("after a restart, the daemon reclaims a deleted session of a project no tab has opened, and keeps one of a project no longer registered", async () => {
	const root = mkdtempSync(join(tmpdir(), "retention-daemon-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const project = (slug: string) => {
		const folder = join(root, slug);
		mkdirSync(folder);
		return {
			path: folder,
			folders: [folder],
			slug,
			title: slug,
			repositoryIdentities: {},
			addedAt: Date.now(),
			lastUsed: Date.now(),
		};
	};
	// "unopened" is registered but no tab opens it; "gone" was removed before this start.
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({
			...defaultDaemonConfig(),
			port: 0,
			projects: [project("integration-test"), project("unopened")],
		}),
	);
	const store = ManagedRuntime.make(
		makePersistenceStoreLayer(join(configDir, "events.db")),
	);
	for (const [projectId, sessionId] of [
		["unopened", "unopened-dead"],
		["gone", "gone-dead"],
	] as const)
		await store.runPromise(
			Effect.gen(function* () {
				const events = yield* makeEventStoreEffect;
				yield* events.appendBatch([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: `Deleted in ${projectId}`,
						provider: "opencode",
					}),
					canonicalEvent("session.deleted", sessionId, { sessionId }),
				]);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}).pipe(Effect.provideService(PersistenceProjectTag, { projectId })),
		);
	await store.dispose();

	harness = await createDaemonProject("chat-simple", { configDir });
	// The opened project's relay hands the daemon's one scheduler on.
	const scheduler = await harness.daemon.runPromise(EventRetentionSchedulerTag);
	expect(await harness.run(EventRetentionSchedulerTag)).toBe(scheduler);
	// Startup already kicked; a drain of "unopened" ending after this point has reclaimed it.
	const retention = await harness.daemon.runPromise(
		scheduler.retention("unopened"),
	);
	const drain = retention.drain;
	const unopenedDrained = new Promise<void>((resolve) =>
		vi
			.spyOn(retention, "drain")
			.mockImplementation(() =>
				drain().pipe(Effect.tap(() => Effect.sync(resolve))),
			),
	);
	await harness.daemon.runPromise(scheduler.kick);
	await unopenedDrained;
	const db = new Database(join(configDir, "events.db"), { readonly: true });
	cleanup.unshift(() => db.close());
	const types = (sessionId: string) =>
		db
			.prepare("SELECT type FROM events WHERE session_id = ? ORDER BY sequence")
			.all(sessionId)
			.map((row) => (row as { type: string }).type);
	expect(types("unopened-dead")).toEqual(["session.deleted"]);
	// The same drain left the removed project's history alone.
	expect(types("gone-dead")).toEqual(["session.created", "session.deleted"]);

	// A delete over RPC reaches the same scheduler. Only that session is reclaimable in this
	// project, so the first drain here that frees a session is the one the delete kicked.
	const client = await harness.connectWsClient();
	await client.waitForInitialState();
	const created = await client.createSession("Deleted over RPC", {
		providerId: "opencode",
	});
	const deletedId = String(created["id"]);
	const opened = await harness.daemon.runPromise(
		scheduler.retention("integration-test"),
	);
	const drainOpened = opened.drain;
	const deleteDrained = new Promise<void>((resolve) =>
		vi
			.spyOn(opened, "drain")
			.mockImplementation(() =>
				drainOpened().pipe(
					Effect.tap((report) =>
						Effect.sync(() => report.sessionsFreed > 0 && resolve()),
					),
				),
			),
	);
	await client.deleteSession(deletedId);
	await deleteDrained;
	expect(types(deletedId)).toEqual(["session.deleted"]);
	mkdirSync("test-results/event-retention", { recursive: true });
	writeFileSync(
		"test-results/event-retention/daemon-scheduler.json",
		`${JSON.stringify(
			{
				unopened: types("unopened-dead"),
				gone: types("gone-dead"),
				deletedOverRpc: types(deletedId),
			},
			null,
			2,
		)}\n`,
	);
});
