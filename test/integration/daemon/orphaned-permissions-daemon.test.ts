// The daemon rejects the Claude asks a crash left pending in every registered project (82tn.16):
// one no tab opens after a restart, one whose folder is missing at start, and one added while it
// runs. A removed project's ask stays as it is, though it shares a registered project's folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { addWithoutRelay } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
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

it("after a restart, the daemon rejects orphaned Claude asks in every registered project, and not a removed project's", async () => {
	const root = mkdtempSync(join(tmpdir(), "orphaned-permissions-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const folder = (name: string) => {
		const path = join(root, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const project = (slug: string, path: string) => ({
		path,
		folders: [path],
		slug,
		title: slug,
		repositoryIdentities: {},
		addedAt: Date.now(),
		lastUsed: Date.now(),
	});
	const shared = folder("shared");
	// "unopened" is registered but no tab opens it; "moved" lost its folder; "gone" was removed
	// before this start and shares "unopened"'s folder; "added" is registered while the daemon runs.
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({
			...defaultDaemonConfig(),
			port: 0,
			projects: [
				project("integration-test", folder("integration-test")),
				project("unopened", shared),
				project("moved", join(root, "missing")),
			],
		}),
	);
	// A Claude session waiting on an ask when the daemon crashed; no process owns it now.
	const store = ManagedRuntime.make(
		makePersistenceStoreLayer(join(configDir, "events.db")),
	);
	const projects = ["unopened", "moved", "gone", "added"] as const;
	for (const projectId of projects)
		await store.runPromise(
			Effect.gen(function* () {
				const sessionId = `${projectId}-session`;
				yield* (yield* makeEventStoreEffect).appendBatch([
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, title: `Asked in ${projectId}`, provider: "claude" },
						{ provider: "claude" },
					),
					canonicalEvent(
						"permission.asked",
						sessionId,
						{
							id: `${projectId}-ask`,
							sessionId,
							toolName: "Bash",
							input: { command: "pwd" },
						},
						{ provider: "claude" },
					),
				]);
				yield* (yield* ProjectionRunnerEffectTag).recover();
			}).pipe(Effect.provideService(PersistenceProjectTag, { projectId })),
		);
	await store.dispose();
	// Each read opens its own connection; one opened before the daemon does not see its writes.
	const statuses = () => {
		const db = new Database(join(configDir, "events.db"), { readonly: true });
		try {
			return Object.fromEntries(
				projects.map((projectId) => [
					projectId,
					(
						db
							.prepare("SELECT status FROM pending_approvals WHERE id = ?")
							.get(`${projectId}-ask`) as { status: string }
					).status,
				]),
			);
		} finally {
			db.close();
		}
	};
	expect(statuses()).toEqual({
		unopened: "pending",
		moved: "pending",
		gone: "pending",
		added: "pending",
	});

	harness = await createDaemonProject("chat-simple", {
		configDir,
		projectDir: join(root, "integration-test"),
	});
	const { daemon } = harness;
	// Daemon start has finished clearing the registered projects.
	const started = statuses();
	// The rejection publishes once its projection is in; the check after subscribing covers
	// one that came first.
	await harness.run(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* (yield* SessionEventBusTag).subscribe({
					sessionId: "added-session",
				});
				// On the daemon's own bus: a project relay's context carries its own.
				yield* Effect.promise(() =>
					daemon.runPromise(
						addWithoutRelay({
							slug: "added",
							title: "added",
							folders: [folder("added")],
						}),
					),
				);
				if (statuses()["added"] === "resolved") return;
				yield* Stream.runHead(
					Stream.filter(events, () => statuses()["added"] === "resolved"),
				);
			}),
		).pipe(Effect.timeout("10 seconds"), Effect.ignore),
	);
	const settled = { started, final: statuses() };
	mkdirSync("test-results/orphaned-permissions-daemon", { recursive: true });
	writeFileSync(
		"test-results/orphaned-permissions-daemon/statuses.json",
		`${JSON.stringify(settled, null, 2)}\n`,
	);
	expect(settled).toEqual({
		started: {
			unopened: "resolved",
			moved: "resolved",
			gone: "pending",
			added: "pending",
		},
		final: {
			unopened: "resolved",
			moved: "resolved",
			gone: "pending",
			added: "resolved",
		},
	});
});
