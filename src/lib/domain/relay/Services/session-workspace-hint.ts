import { SqlClient } from "@effect/sql";
import { Effect, Layer, Schema, Stream } from "effect";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { StoredEvent } from "../../../contracts/stored-event.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	EventStoreError,
} from "../../../persistence/effect/event-store-effect.js";
import { announceSidebar } from "../../../persistence/effect/sidebar-projection.js";
import {
	decodeStoredEventRow,
	type StoredEventRow,
} from "../../../persistence/effect/stored-event-row.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../../persistence/events.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import {
	collectWorkspaceHintPaths,
	resolveWorkspaceHint,
} from "../../../session/workspace-hint.js";
import { PersistenceProjectTag } from "../../persistence/Services/persistence-service.js";
import { ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { SessionWorkspaceTag } from "./session-workspace.js";
import { SessionWorkspaceHintStateTag } from "./session-workspace-hint-state.js";

/** Dismiss in memory, but stamp the normal row so every tab re-reads it. */
export const dismissWorkspaceHint = (sessionId: string, path: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const dismissals = yield* SessionWorkspaceHintStateTag;
		yield* commit.write((_project, stamp) =>
			Effect.gen(function* () {
				const [row] = yield* sql<{
					path: string | null;
					sequence: number | null;
				}>`
						SELECT workspace_hint AS path, workspace_hint_sequence AS sequence
						FROM sessions WHERE id = ${sessionId}`;
				// A stale browser action must not dismiss a different folder.
				if (row?.path !== path || row.sequence === null) return;
				dismissals.set(sessionId, row.sequence);
				yield* stamp((version) =>
					sql<{ id: string }>`
							UPDATE sessions SET version = ${version}
							WHERE id = ${sessionId} RETURNING id`.pipe(
						Effect.map((rows) => rows.map(({ id }) => id)),
						// Stored sidebar content stays durable, so force its range marker.
						Effect.tap(() => announceSidebar(sessionId, version)),
					),
				);
			}),
		);
	});

const decodeMove = Schema.decodeUnknownSync(
	Schema.parseJson(SessionWorkspaceChangedPayloadSchema),
);
const decodeWorkspace = Schema.decodeUnknownSync(
	Schema.parseJson(SessionWorkspaceSchema),
);

/** Observe live turn ends; projection and replay only fold the recorded result. */
export const SessionWorkspaceHintReactorLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const bus = yield* SessionEventBusTag;
		const workspace = yield* SessionWorkspaceTag;
		const config = yield* ConfigTag;
		const { projectId } = yield* PersistenceProjectTag;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const events = yield* bus.subscribe();
		const observations = yield* Effect.makeSemaphore(1);
		const observedTurns = new Map<string, number>();

		const observeTurn = (end: StoredEvent) =>
			Effect.gen(function* () {
				const [{ previous = 0 } = {}] = yield* sql<{ previous: number }>`
					SELECT COALESCE(MAX(sequence), 0) AS previous FROM events
					WHERE session_id = ${end.sessionId} AND sequence < ${end.sequence}
					AND type IN ('turn.completed', 'turn.error', 'turn.interrupted')`;
				const [{ start } = {}] = yield* sql<{ start: number | null }>`
					SELECT MAX(sequence) AS start FROM events
					WHERE session_id = ${end.sessionId} AND sequence > ${previous}
					AND sequence < ${end.sequence} AND type = 'input.sent'
					AND COALESCE(json_extract(data, '$.steer'), 0) = 0`;
				const boundary =
					start ??
					(yield* sql<{ start: number | null }>`
						SELECT MIN(sequence) AS start FROM events
						WHERE session_id = ${end.sessionId} AND sequence > ${previous}
						AND sequence < ${end.sequence} AND type = 'tool.started'`)[0]
						?.start ??
					end.sequence;
				const [move] = yield* sql<{ data: string }>`
					SELECT data FROM events WHERE session_id = ${end.sessionId}
					AND type = 'session.workspace_changed' AND sequence < ${boundary}
					AND json_extract(data, '$.cause') != 'branch-rename'
					ORDER BY sequence DESC LIMIT 1`;
				const decoded = move ? decodeMove(move.data) : undefined;
				const recorded =
					decoded && decoded.cause !== "branch-rename"
						? { ...decoded, cause: decoded.cause }
						: undefined;
				const directory =
					recorded?.path ??
					effectiveWorkingDirectory(config.projectDir, recorded);
				const rows = yield* sql<StoredEventRow>`
					SELECT project_id, sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at FROM events
					WHERE session_id = ${end.sessionId} AND sequence >= ${boundary}
					AND sequence < ${end.sequence}
					AND type IN ('tool.started', 'tool.running', 'tool.completed',
						'session.workspace_changed') ORDER BY sequence`;
				const tools = yield* Effect.forEach(rows, (row) =>
					decodeStoredEventRow(
						row,
						(cause) =>
							new EventStoreError({ operation: "workspace.hint", cause }),
					),
				);
				const path = yield* resolveWorkspaceHint(
					end.sessionId,
					collectWorkspaceHintPaths(tools, directory),
					workspace.resolve,
				);
				if (path === undefined) return;
				const main = yield* realWorkspacePath(config.projectDir).pipe(
					Effect.orElseSucceed(() => config.projectDir),
				);
				yield* commit.write((project) =>
					Effect.gen(function* () {
						const [row] = yield* sql<{
							workspace: string | null;
							workspace_hint: string | null;
						}>`SELECT workspace, workspace_hint FROM sessions WHERE id = ${end.sessionId}`;
						if (!row) return;
						const current = effectiveWorkingDirectory(
							config.projectDir,
							row.workspace ? decodeWorkspace(row.workspace) : undefined,
						);
						// A user can accept/move during resolution. Do not restore a matching hint.
						const hint =
							path === (current === config.projectDir ? main : current)
								? null
								: path;
						if (row.workspace_hint === hint) return;
						const stored = yield* store.append({
							eventId: `workspace-hint:${end.eventId}`,
							sessionId: end.sessionId,
							type: "session.workspace_hint_changed",
							data: { path: hint },
							metadata: {
								causationEventId: end.eventId,
								source: "workspace-hint",
							},
							provider: end.provider,
							createdAt: end.createdAt,
						});
						yield* project([stored]);
					}),
				);
			});

		yield* Effect.forkScoped(
			Stream.runForEach(events, (event) => {
				if (event.projectId !== projectId) return Effect.void;
				if (
					event.type === "turn.completed" ||
					event.type === "turn.error" ||
					event.type === "turn.interrupted"
				)
					// Drain the sliding bus promptly, but preserve null/back generations
					// while git/filesystem I/O runs. A late notification cannot go backwards.
					return observations
						.withPermits(1)(
							Effect.suspend(() => {
								if ((observedTurns.get(event.sessionId) ?? 0) >= event.sequence)
									return Effect.void;
								observedTurns.set(event.sessionId, event.sequence);
								return observeTurn(event);
							}),
						)
						.pipe(
							Effect.catchAll((error) =>
								Effect.logWarning("Could not observe workspace hint", error),
							),
							Effect.forkScoped,
							Effect.asVoid,
						);
				return Effect.void;
			}),
		);
	}),
);
