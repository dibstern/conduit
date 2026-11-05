// One status poller per daemon (82tn.16): at start it settles a stale busy session of every
// registered project, including one no tab has opened since a restart, and none of a removed one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
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
	for (const dispose of cleanup.splice(0)) dispose();
});

it("after a restart, the daemon settles a stale busy session of a project no tab has opened, and leaves one of a removed project", async () => {
	const root = mkdtempSync(join(tmpdir(), "status-poller-daemon-"));
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
	// Busy for over the 30-minute stale threshold, with no run and nothing awaiting the user.
	const stale = Date.now() - 31 * 60_000;
	const store = ManagedRuntime.make(
		makePersistenceStoreLayer(join(configDir, "events.db")),
	);
	for (const projectId of ["integration-test", "unopened", "gone"])
		await store.runPromise(
			Effect.gen(function* () {
				const sessionId = `${projectId}-stuck`;
				const events = yield* makeEventStoreEffect;
				yield* events.appendBatch([
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, title: `Stuck in ${projectId}`, provider: "opencode" },
						{ createdAt: stale },
					),
					canonicalEvent(
						"session.status",
						sessionId,
						{ sessionId, status: "busy" },
						{ createdAt: stale },
					),
				]);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}).pipe(Effect.provideService(PersistenceProjectTag, { projectId })),
		);
	await store.dispose();
	// Each read opens its own connection; one opened before the daemon does not see its writes.
	const statusOf = (projectId: string) => {
		const db = new Database(join(configDir, "events.db"), { readonly: true });
		try {
			return (
				db
					.prepare("SELECT status FROM sessions WHERE id = ?")
					.get(`${projectId}-stuck`) as { status: string }
			).status;
		} finally {
			db.close();
		}
	};
	expect(["integration-test", "unopened", "gone"].map(statusOf)).toEqual([
		"busy",
		"busy",
		"busy",
	]);

	// The daemon's first poll runs before it serves, so the rows read settled once it is up.
	harness = await createDaemonProject("chat-simple", { configDir });
	const statuses = {
		opened: statusOf("integration-test"),
		unopened: statusOf("unopened"),
		gone: statusOf("gone"),
	};
	mkdirSync("test-results/status-poller", { recursive: true });
	writeFileSync(
		"test-results/status-poller/daemon-poller.json",
		`${JSON.stringify(statuses, null, 2)}\n`,
	);
	expect(statuses).toEqual({ opened: "idle", unopened: "idle", gone: "busy" });
});
