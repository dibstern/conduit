// ─── Session Command Seam ───────────────────────────────────────────────────
// One pipeline for every session mutation: append the canonical event, project
// it strictly, then sync upstream best-effort.
//
// Before this module each mutating method picked its own backends: rename wrote
// the event store AND OpenCode, delete wrote OpenCode only, create wrote
// OpenCode only. listSessions has always read the SQLite read model, so a
// mutation that skipped the event store simply never reached the UI — which is
// exactly how conduit-test-42k7 (deleted sessions reappearing) happened.
//
// See docs/adr/0004-session-mutations-are-canonical-events.md.

import { SqlClient } from "@effect/sql";
import { Data, Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { ConfigTag, LoggerTag } from "./services.js";

const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SDK_PROVIDER_ID = "claude-sdk";

export class SessionCommandError extends Data.TaggedError(
	"SessionCommandError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * A session mutation, typed as the canonical event it becomes. Indexing
 * `EventPayloadMap` is what makes the parity gap unrepresentable: a mutation
 * with no `session.*` event cannot be expressed as a command, and the read
 * model is projected from those events, so it cannot drift from them either.
 */
type SessionCommandType =
	| "session.created"
	| "session.renamed"
	| "session.read"
	| "session.unread"
	| "session.deleted"
	| "session.forked";

export type SessionCommand = {
	[K in SessionCommandType]: {
		readonly type: K;
		readonly data: EventPayloadMap[K];
	};
}[SessionCommandType];

// ─── Upstream sync adapters ─────────────────────────────────────────────────

/**
 * Upstream sync varies for a real reason: OpenCode keeps its own session
 * registry that has to be told about mutations, and the Claude Agent SDK has no
 * such registry. Two adapters, so the seam is real rather than hypothetical.
 *
 * Sync is best-effort by contract — the local write is authoritative, so a
 * failure here is logged, never propagated.
 */
export interface SessionUpstreamAdapter {
	readonly provider: "opencode" | "claude";
	readonly sync: (command: SessionCommand) => Effect.Effect<void, unknown>;
}

export const openCodeUpstreamAdapter = (
	api: OpenCodeAPI,
): SessionUpstreamAdapter => ({
	provider: "opencode",
	sync: (command) => {
		switch (command.type) {
			case "session.deleted":
				// No retry: delete is not idempotent, and upstream cleanup is
				// best-effort.
				return Effect.tryPromise(() =>
					api.session.delete(command.data.sessionId),
				);
			case "session.renamed":
				return Effect.tryPromise(() =>
					api.session.update(command.data.sessionId, {
						title: command.data.title,
					}),
				);
			case "session.created":
				// Whoever created the session chose its id — upstream for
				// OpenCode-backed sessions, locally for the rest — so by the time this
				// event exists upstream already has it. Nothing to replicate.
				return Effect.void;
			case "session.read":
			case "session.unread":
				// Read state belongs to Conduit and has no provider-side equivalent.
				return Effect.void;
			case "session.forked":
				// Same: the fork happened upstream first, which is where the forked
				// session's id came from. This event records its lineage locally.
				return Effect.void;
		}
	},
});

export const claudeUpstreamAdapter: SessionUpstreamAdapter = {
	provider: "claude",
	// The Claude Agent SDK has no server-side session registry to keep in step.
	sync: () => Effect.void,
};

export const isClaudeSessionRow = (
	row: SessionRow,
	configDir?: string,
): boolean =>
	row.provider === CLAUDE_SDK_PROVIDER_ID ||
	resolveProviderRoutingDriver(loadDaemonConfig(configDir), row.provider) ===
		CLAUDE_PROVIDER_ID;

// ─── The seam ───────────────────────────────────────────────────────────────

/**
 * Apply a session mutation: append, project, sync.
 *
 * The local write is authoritative and strict — if the projection fails, so
 * does this effect, because a user told the session was deleted must not find
 * it still listed. Upstream sync is best-effort and cannot fail the command.
 *
 * When the SQLite services are absent (relay stacks that run without an event
 * store) the local write is skipped and only upstream sync runs, which is the
 * behaviour every mutating method had before this module existed.
 */
export const applySessionCommand = (command: SessionCommand) =>
	Effect.gen(function* () {
		// Optional: a Claude-only relay never wires the OpenCode API, and a
		// mutation on a Claude-backed session has no upstream to reach anyway.
		// Requiring it here would put OpenCode in the type of every local create.
		const apiOption = yield* Effect.serviceOption(OpenCodeAPITag);
		const logOption = yield* Effect.serviceOption(LoggerTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);

		const { sessionId } = command.data;
		let row: SessionRow | undefined;

		if (
			readQueryOption._tag === "Some" &&
			eventStoreOption._tag === "Some" &&
			projectionRunnerOption._tag === "Some" &&
			sqlOption._tag === "Some"
		) {
			const eventStore = eventStoreOption.value;
			const projectionRunner = projectionRunnerOption.value;
			const sql = sqlOption.value;
			const withSql = <A, E>(
				effect: Effect.Effect<A, E, SqlClient.SqlClient>,
			): Effect.Effect<A, E> =>
				effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

			const recovered = yield* projectionRunner.isRecovered();
			if (!recovered) {
				yield* withSql(projectionRunner.recover()).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({
								operation: `${command.type}.recover`,
								cause,
							}),
					),
					Effect.asVoid,
				);
			}

			row = yield* readQueryOption.value.getSession(sessionId).pipe(
				Effect.mapError(
					(cause) =>
						new SessionCommandError({
							operation: `${command.type}.getSession`,
							cause,
						}),
				),
			);

			// session.created is the one command that does not require an existing
			// row — it is what brings the row into being, and its payload names the
			// provider. Every other command describes a change to a row that must
			// already be there: no row is not an error (it may already be gone, and
			// upstream may still hold it), there is simply nothing to record.
			// This is why forkOpenCodeSession applies session.created before any
			// session.forked can land: an UPDATE onto a row that is not there yet
			// writes nothing and reports success.
			const appendProvider =
				command.type === "session.created"
					? command.data.provider
					: row?.provider;

			if (appendProvider !== undefined) {
				const stored = yield* eventStore
					.append(
						canonicalEvent(command.type, sessionId, command.data, {
							provider: appendProvider,
							createdAt: Date.now(),
							metadata: { source: "relay" },
						}),
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new SessionCommandError({
									operation: `${command.type}.append`,
									cause,
								}),
						),
					);

				yield* withSql(projectionRunner.projectEvent(stored)).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({
								operation: `${command.type}.project`,
								cause,
							}),
					),
				);
			}
		}

		// No adapter means no upstream to sync: the relay has no OpenCode API
		// wired at all, so there is no session registry anywhere to fall out of
		// step with.
		const adapter =
			row !== undefined &&
			isClaudeSessionRow(
				row,
				configOption._tag === "Some" ? configOption.value.configDir : undefined,
			)
				? claudeUpstreamAdapter
				: apiOption._tag === "Some"
					? openCodeUpstreamAdapter(apiOption.value)
					: undefined;

		if (adapter !== undefined) {
			yield* adapter.sync(command).pipe(
				Effect.catchAll((cause) =>
					Effect.sync(() => {
						if (logOption._tag === "Some") {
							logOption.value.warn("Upstream session sync failed", {
								operation: command.type,
								sessionId,
								cause,
							});
						}
					}),
				),
			);
		}
	}).pipe(
		Effect.annotateLogs("sessionId", command.data.sessionId),
		Effect.withSpan("session.applySessionCommand", {
			attributes: { sessionId: command.data.sessionId, type: command.type },
		}),
	);

// ─── Creation ───────────────────────────────────────────────────────────────

export const normalizeSessionTitle = (title?: string): string => {
	const trimmed = title?.trim();
	return trimmed ? trimmed : "Untitled";
};

/**
 * Create a session on an OpenCode server and record it locally.
 *
 * The one mutation that cannot be expressed as a command on its own: OpenCode
 * chooses the session id, and a command needs that id before it can be built.
 * So the direct `api.session.create` call lives here, next to the sync adapter,
 * and applying `session.created` is folded into the same function rather than
 * left to the caller.
 *
 * That folding is the point. A caller who creates the session upstream and
 * forgets to record it locally is how conduit-test-42k7 happened; there is no
 * longer a way to express it from outside this module.
 */
export const createOpenCodeSession = (
	title: string | undefined,
	provider: string,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;

		// No retry: create is not idempotent — retrying could produce duplicates.
		const session = yield* Effect.tryPromise(() =>
			api.session.create(title ? { title } : undefined),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionCommandError({
						operation: "session.created.upstream",
						cause,
					}),
			),
		);

		yield* applySessionCommand({
			type: "session.created",
			data: {
				sessionId: session.id,
				title: normalizeSessionTitle(session.title),
				provider,
				providerSessionId: session.id,
			},
		});

		return session;
	}).pipe(
		Effect.annotateLogs("operation", "createOpenCodeSession"),
		Effect.withSpan("session.createOpenCodeSession"),
	);

/**
 * Fork a session on an OpenCode server and record the forked session locally.
 *
 * Creation's asymmetry again: OpenCode chooses the forked session's id, so the
 * direct `api.session.fork` call lives here and `session.created` is applied in
 * the same function. Before this, the forked session reached the read model
 * only if the provider event stream happened to mention it — with no parent, so
 * it surfaced as a root session in the sidebar (conduit-test-o5vp).
 *
 * The fork point itself follows as `session.forked`, once the caller has
 * resolved which message it was.
 */
export const forkOpenCodeSession = (
	parentSessionId: string,
	messageId?: string,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);

		// No retry: fork is not idempotent — retrying could produce duplicates.
		const session = yield* Effect.tryPromise(() =>
			api.session.fork(parentSessionId, {
				...(messageId != null && { messageID: messageId }),
			}),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionCommandError({
						operation: "session.forked.upstream",
						cause,
					}),
			),
		);

		// A fork inherits its parent's provider. Forking is an OpenCode
		// operation, so an unreadable parent can only mean the read model is not
		// wired here at all — in which case nothing is projected anyway.
		const parent =
			readQueryOption._tag === "Some"
				? yield* readQueryOption.value
						.getSession(parentSessionId)
						.pipe(Effect.orElseSucceed(() => undefined))
				: undefined;

		yield* applySessionCommand({
			type: "session.created",
			data: {
				sessionId: session.id,
				title: normalizeSessionTitle(session.title),
				provider: parent?.provider ?? "opencode",
				parentId: parentSessionId,
				providerSessionId: session.id,
			},
		});

		return session;
	}).pipe(
		Effect.annotateLogs("operation", "forkOpenCodeSession"),
		Effect.withSpan("session.forkOpenCodeSession"),
	);
