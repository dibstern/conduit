import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { listDaemonSessions } from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { makeRelayStatusSnapshot } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { announceBackgroundWork } from "../../../src/lib/domain/relay/Services/session-attention.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeSessionFamily } from "../../../src/lib/domain/relay/Services/session-family-subscription.js";
import { makeSessionListOperations } from "../../../src/lib/domain/relay/Services/session-manager-list.js";
import { emptySessionManagerState } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { createSessionGitCache } from "../../../src/lib/git/session-git.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const sessionId = "same-session";

const rowFields = (row: SessionInfo | undefined) => {
	if (!row) throw new Error("Expected the seeded session row");
	return {
		attention: row.attention,
		backgroundWork: row.backgroundWork,
		compacting: row.compacting,
		retrying: row.retrying,
		workspaceHint: row.workspaceHint,
		status: row.status,
	};
};

const snapshotRow = (snapshot: Option.Option<Envelope<SessionInfo>>) => {
	if (Option.isNone(snapshot) || snapshot.value._tag !== "snapshot")
		throw new Error("Expected a subscription snapshot");
	return snapshot.value.rows.find((row) => row.id === sessionId);
};

describe("Session Rows read paths", () => {
	for (const [taskType, attention] of [
		["local_bash", "monitoring"],
		["workflow", "working"],
	] as const) {
		it.effect(
			`shares ${attention} activity and hint dismissals across all four readers`,
			() => {
				const configDir = mkdtempSync(join(tmpdir(), "conduit-session-rows-"));
				const projectDir = join(configDir, "project-folder");
				const slug = "project";
				const folders: [string] = [projectDir];
				mkdirSync(projectDir);
				return Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() =>
							rmSync(configDir, { recursive: true, force: true }),
						),
					);
					const activity = yield* makeSessionActivity;
					const activityLayer = Layer.succeed(SessionActivityTag, activity);
					const persistence = makePersistenceEffectLayer(
						join(configDir, "events.db"),
						slug,
						undefined,
						SessionEventBusLive,
					).pipe(Layer.provide(activityLayer));
					const store = Layer.effect(
						PersistenceStore,
						Effect.context<PersistenceStoreContext>(),
					).pipe(Layer.provideMerge(persistence));
					const layer = Layer.mergeAll(
						store,
						activityLayer,
						SessionEventBusLive,
						Layer.succeed(
							ConfigTag,
							makeMockConfig({ configDir, projectDir, slug }),
						),
						Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
						makeProjectRegistryLive([{ slug, title: "Project", folders }]),
					);
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const readQuery = yield* ReadQueryEffectTag;
						const accounts = yield* AccountDirectory;
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.recover();
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent("session.created", sessionId, {
								sessionId,
								title: "Shared row",
								provider: "claude",
							}),
							canonicalEvent("session.workspace_hint_changed", sessionId, {
								path: "/workspace/hint",
							}),
						]);
						activity.background.record({
							sessionId,
							kind: "snapshot",
							tasks: [
								{ id: "task", type: taskType, description: "Background work" },
							],
						});
						activity.compactions.observe([
							canonicalEvent("session.compaction", sessionId, {
								sessionId,
								state: "started",
								detail: "Compacting context",
							}),
						]);
						activity.retries.observe([
							canonicalEvent("session.status", sessionId, {
								sessionId,
								status: "retry",
								message: "Retrying request",
							}),
						]);
						yield* announceBackgroundWork(sessionId);
						const operations = makeSessionListOperations({
							api: makeMockOpenCodeAPI(),
							stateRef: yield* Ref.make(emptySessionManagerState()),
							readQuery,
							sql,
							accounts,
							statusPollerOption: Option.none(),
							activity,
							snapshot: makeRelayStatusSnapshot(),
							projectFolders: folders,
							projectSlug: slug,
						});
						const cache = createSessionGitCache(async () => undefined);
						const readAll = Effect.gen(function* () {
							const relay = yield* operations.serviceListSessions();
							const shell = yield* Stream.runHead(
								subscribeShell().pipe(
									Stream.filter((frame) => frame._tag !== "projects"),
								),
							);
							const family = yield* Stream.runHead(
								subscribeSessionFamily({ sessionId }),
							);
							const daemon = yield* listDaemonSessions({}, cache);
							expect(daemon.availability).toEqual([
								{ projectSlug: slug, available: true },
							]);
							return [
								relay.find((row) => row.id === sessionId),
								snapshotRow(shell),
								snapshotRow(family),
								daemon.sessions.find((row) => row.id === sessionId),
							];
						});
						const visible = yield* readAll;
						for (const row of visible)
							expect(rowFields(row)).toEqual({
								attention,
								backgroundWork: attention,
								compacting: "Compacting context",
								retrying: "Retrying request",
								workspaceHint: "/workspace/hint",
								status: "idle",
							});
						const [stored] = yield* sql<{ workspace_hint_sequence: number }>`
						SELECT workspace_hint_sequence FROM sessions WHERE id = ${sessionId}`;
						if (!stored) throw new Error("Expected the stored hint generation");
						activity.hintDismissals.set(
							sessionId,
							stored.workspace_hint_sequence,
						);
						for (const row of yield* readAll) {
							expect(rowFields(row)).toEqual({
								...rowFields(visible[0]),
								workspaceHint: undefined,
							});
						}
					}).pipe(Effect.provide(layer));
				});
			},
		);
	}
});
