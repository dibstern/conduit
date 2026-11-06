// A project added while the daemon's event bus is saturated is still served (82tn.77): its
// crash-orphaned Claude ask is cleared, and removing it closes its hosted terminal. The bus slides:
// a listener that is behind loses its oldest messages, here the add's. Artifact:
// test-results/added-project-saturated-bus/result.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime, PubSub, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addWithoutRelay,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceStoreLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { StoredProject } from "../../../src/lib/types.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

// The host runs from dist, as the daemon spawns it.
const DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const { PtyHostClient, stopPtyHost } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-client.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-client.js");

let harness: DaemonProject | undefined;
let host: Awaited<ReturnType<typeof PtyHostClient.connect>> | undefined;
const cleanup: (() => unknown)[] = [];
// Written whether the test passes or not, so a failure shows the last step reached.
const evidence: Record<string, unknown> = {};
afterEach(async () => {
	mkdirSync("test-results/added-project-saturated-bus", { recursive: true });
	writeFileSync(
		"test-results/added-project-saturated-bus/result.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	host?.disconnect();
	host = undefined;
	await harness?.stop();
	harness = undefined;
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it("serves a project added while the daemon's bus is saturated: clears its orphaned ask and closes its terminals on removal", async () => {
	const root = mkdtempSync(join(tmpdir(), "added-saturated-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	cleanup.push(() => stopPtyHost({ configDir, force: true }));
	const folder = (name: string) => {
		const path = join(root, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const addedFolder = folder("added");
	const added: StoredProject = {
		slug: "added",
		title: "added",
		folders: [addedFolder],
	};
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({
			...defaultDaemonConfig(),
			port: 0,
			projects: [
				{
					path: folder("integration-test"),
					folders: [folder("integration-test")],
					slug: "integration-test",
					title: "integration-test",
					addedAt: Date.now(),
				},
			],
		}),
	);
	// "added" was removed while never opened, so its ask outlived it; it comes back while the daemon runs.
	const store = ManagedRuntime.make(
		makePersistenceStoreLayer(join(configDir, "events.db")),
	);
	await store.runPromise(
		Effect.gen(function* () {
			yield* (yield* makeEventStoreEffect).appendBatch([
				canonicalEvent(
					"session.created",
					"added-session",
					{
						sessionId: "added-session",
						title: "Asked in added",
						provider: "claude",
					},
					{ provider: "claude" },
				),
				canonicalEvent(
					"permission.asked",
					"added-session",
					{
						id: "added-ask",
						sessionId: "added-session",
						toolName: "Bash",
						input: { command: "pwd" },
					},
					{ provider: "claude" },
				),
			]);
			yield* (yield* ProjectionRunnerEffectTag).recover();
		}).pipe(
			Effect.provideService(PersistenceProjectTag, { projectId: "added" }),
		),
	);
	await store.dispose();
	// Each read opens its own connection; one opened before the daemon does not see its writes.
	const askStatus = () => {
		const db = new Database(join(configDir, "events.db"), { readonly: true });
		try {
			return (
				db
					.prepare("SELECT status FROM pending_approvals WHERE id = ?")
					.get("added-ask") as { status: string }
			).status;
		} finally {
			db.close();
		}
	};

	harness = await createDaemonProject("chat-simple", {
		configDir,
		projectDir: folder("integration-test"),
	});
	const { daemon } = harness;
	host = await PtyHostClient.connect({ configDir });
	const hosted = host;
	const openTerminal = async () => {
		const session = await hosted.create({ cwd: addedFolder });
		// Wrapped: an async function returning the exit promise would wait for the exit.
		return {
			exited: new Promise<number>((resolve) => session.onExit(resolve)),
		};
	};
	/** True when the closed terminal exited within the wait, false when it stayed open. */
	const closedOn = ({ exited }: { exited: Promise<number> }) =>
		Effect.runPromise(
			Effect.promise(() => exited).pipe(
				Effect.as(true),
				Effect.timeout("5 seconds"),
				Effect.catch(() => Effect.succeed(false)),
			),
		);
	// What a listener sees when the bus drops a project's add: the project is registered, its add
	// is gone, and later messages fill the buffer (a sliding bus drops a message only to make room
	// for a newer one). A listener that is waiting takes each message inline with its publisher, so
	// it loses one only while its handler is suspended (during runner recovery, or behind an owner
	// scope a removal holds while it closes terminals), a window a test cannot pin. The test
	// registers silently and floods the bus instead.
	const addWhileSaturated = () =>
		daemon.runPromise(
			Effect.gen(function* () {
				yield* addWithoutRelay(added, { silent: true });
				yield* PubSub.publishAll(
					yield* DaemonEventBusTag,
					Array.from({ length: 300 }, () =>
						DaemonEvent.DiskSpaceOk({ usage: 0 }),
					),
				);
			}),
		);

	const firstTerminal = await openTerminal();
	evidence["askBefore"] = askStatus();
	// The rejection publishes once its projection is in; the check after the add covers one
	// that came first.
	await harness.run(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* (yield* SessionEventBusTag).subscribe({
					sessionId: "added-session",
				});
				yield* Effect.promise(addWhileSaturated);
				if (askStatus() !== "resolved")
					yield* Stream.runHead(
						Stream.filter(events, () => askStatus() === "resolved"),
					).pipe(Effect.timeout("10 seconds"), Effect.ignore);
			}),
		),
	);
	evidence["askAfterAdd"] = askStatus();
	await daemon.runPromise(remove(added.slug));
	evidence["firstRemovalClosedTerminal"] = await closedOn(firstTerminal);

	// Added back while saturated: the new registration is a new project, served again.
	await addWhileSaturated();
	const secondTerminal = await openTerminal();
	await daemon.runPromise(remove(added.slug));
	evidence["secondRemovalClosedTerminal"] = await closedOn(secondTerminal);

	expect(evidence).toEqual({
		askBefore: "pending",
		askAfterAdd: "resolved",
		firstRemovalClosedTerminal: true,
		secondRemovalClosedTerminal: true,
	});
});
