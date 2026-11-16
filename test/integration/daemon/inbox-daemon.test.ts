// The inbox serves every registered project from daemon start (82tn.16): a message queued in
// a project no tab opens after a restart is sent without one, and a removed project's is not.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
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

it("after a restart, the daemon sends a message queued in a project no tab has opened, and not one of a removed project", async () => {
	const root = mkdtempSync(join(tmpdir(), "inbox-daemon-"));
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
	// An idle session holding a queued message: the daemon stopped after the turn it waited
	// behind ended and before the inbox sent it.
	const store = ManagedRuntime.make(
		makePersistenceStoreLayer(join(configDir, "events.db")),
	);
	for (const projectId of ["unopened", "gone"])
		await store.runPromise(
			Effect.gen(function* () {
				const sessionId = `${projectId}-session`;
				yield* (yield* makeEventStoreEffect).appendBatch([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: `Queued in ${projectId}`,
						provider: "opencode",
					}),
					canonicalEvent("session.status", sessionId, {
						sessionId,
						status: "idle",
					}),
					canonicalEvent("input.admitted", sessionId, {
						sessionId,
						inputId: `${projectId}-input`,
						delivery: "queue",
						request: { text: "sent after the restart" },
					}),
				]);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}).pipe(Effect.provideService(PersistenceProjectTag, { projectId })),
		);
	await store.dispose();
	// Each read opens its own connection; one opened before the daemon does not see its writes.
	// Sent: the message left the queue and its turn was requested.
	const sentOf = (projectId: string) => {
		const db = new Database(join(configDir, "events.db"), { readonly: true });
		try {
			return (
				db
					.prepare(
						`SELECT (SELECT state FROM pending_inputs WHERE input_id = ?) != 'queued'
							AND EXISTS (SELECT 1 FROM events WHERE session_id = ? AND type = 'run.requested') AS sent`,
					)
					.get(`${projectId}-input`, `${projectId}-session`) as { sent: number }
			).sent;
		} finally {
			db.close();
		}
	};
	expect([sentOf("unopened"), sentOf("gone")]).toEqual([0, 0]);

	harness = await createDaemonProject("chat-simple", { configDir });
	// The bus publishes once a commit's projection is in, so each of the session's events
	// re-reads the store; the check after subscribing covers a send that came first.
	await harness.run(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* (yield* SessionEventBusTag).subscribe({
					sessionId: "unopened-session",
				});
				if (sentOf("unopened") === 1) return;
				yield* Stream.runHead(
					Stream.filter(events, () => sentOf("unopened") === 1),
				);
			}),
		),
	);
	const sent = { unopened: sentOf("unopened"), gone: sentOf("gone") };
	mkdirSync("test-results/inbox-daemon", { recursive: true });
	writeFileSync(
		"test-results/inbox-daemon/daemon-inbox.json",
		`${JSON.stringify(sent, null, 2)}\n`,
	);
	expect(sent).toEqual({ unopened: 1, gone: 0 });
});
