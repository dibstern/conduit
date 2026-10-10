// Failure modes outside the daemon's browser contract:
// - Enter/Exit state inferred from the current folder rather than declarations.
// - An unrelated tool, failed tool, or another session overwrites that state.
// - A user move back to main disappears because workspace projects to NULL.
// - A startup before the user request, or a mismatching startup, clears intent.
// - Symlinked cwd reports fail to acknowledge the same requested folder.
// - A matching tool declaration fails to acknowledge a pending user request.
// - A new service instance loses state that was already recorded.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const withWorkspace = <A, E>(
	use: (
		root: string,
	) => Effect.Effect<A, E, SessionWorkspaceTag | SqlClient.SqlClient>,
) => {
	const root = mkdtempSync(join(tmpdir(), "conduit-workspace-state-"));
	const dependencies = Layer.mergeAll(
		makePersistenceEffectLayer(join(root, "events.db")),
		Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Layer.succeed(
			ConfigTag,
			makeMockConfig({ projectDir: root, configDir: root }),
		),
		Layer.succeed(LoggerTag, makeMockLogger()),
	);
	return use(root).pipe(
		Effect.provide(SessionWorkspaceLive.pipe(Layer.provideMerge(dependencies))),
		Effect.ensuring(
			Effect.sync(() => rmSync(root, { recursive: true, force: true })),
		),
	);
};

const record = (
	type: "tool.completed" | "session.status" | "session.workspace_changed",
	metadata: Record<string, unknown> = {},
	data: Record<string, unknown> = {},
	sessionId = "session",
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT OR IGNORE INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (${sessionId}, 'claude', 'Workspace', 'idle', 1, 1)`;
		yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at) SELECT lower(hex(randomblob(16))), ${sessionId}, COALESCE(MAX(stream_version) + 1, 0), ${type}, ${JSON.stringify(data)}, ${JSON.stringify(metadata)}, 'claude', 1 FROM events WHERE session_id = ${sessionId}`;
	});

describe("recorded Claude workspace state", () => {
	it.effect(
		"derives active Enter/Exit state without interpreting unrelated tools or other sessions",
		() =>
			withWorkspace((root) =>
				Effect.gen(function* () {
					const workspace = yield* SessionWorkspaceTag;
					yield* record("session.status");
					expect(yield* workspace.claudeWorktreeState("session")).toEqual({
						enteredWorktree: false,
						pendingUserMove: false,
					});
					yield* record("tool.completed", {
						claudeWorktree: { entered: true, path: root },
					});
					yield* record("tool.completed");
					yield* record(
						"tool.completed",
						{ claudeWorktree: { entered: false, path: root } },
						{},
						"other",
					);
					expect(
						(yield* workspace.claudeWorktreeState("session")).enteredWorktree,
					).toBe(true);
					yield* record("tool.completed", {
						claudeWorktree: { entered: false, path: root },
					});
					expect(
						(yield* workspace.claudeWorktreeState("session")).enteredWorktree,
					).toBe(false);
				}),
			),
	);

	it.effect(
		"keeps a move to main pending until a later matching startup acknowledges it",
		() =>
			withWorkspace((root) =>
				Effect.gen(function* () {
					const workspace = yield* SessionWorkspaceTag;
					yield* record("session.status", { workspaceCwd: root });
					yield* record(
						"session.workspace_changed",
						{},
						{
							sessionId: "session",
							cause: "user",
							worktrees: {},
							origin: "existing",
						},
					);
					yield* record("session.status", {
						workspaceCwd: join(root, "other"),
					});
					expect(
						(yield* workspace.claudeWorktreeState("session")).pendingUserMove,
					).toBe(true);
					const alias = join(root, "alias");
					symlinkSync(root, alias);
					yield* record("session.status", { workspaceCwd: alias });
					expect(
						(yield* workspace.claudeWorktreeState("session")).pendingUserMove,
					).toBe(false);
				}),
			),
	);

	it.effect(
		"acknowledges a matching declaration and clears an older request after an agent move",
		() =>
			withWorkspace((root) =>
				Effect.gen(function* () {
					const workspace = yield* SessionWorkspaceTag;
					yield* record(
						"session.workspace_changed",
						{},
						{
							sessionId: "session",
							cause: "user",
							worktrees: {},
							origin: "existing",
						},
					);
					yield* record("tool.completed", {
						claudeWorktree: { entered: false, path: root },
					});
					expect(
						(yield* workspace.claudeWorktreeState("session")).pendingUserMove,
					).toBe(false);
					yield* record(
						"session.workspace_changed",
						{},
						{
							sessionId: "session",
							cause: "user",
							worktrees: {},
							origin: "existing",
						},
					);
					expect(
						(yield* workspace.claudeWorktreeState("session")).pendingUserMove,
					).toBe(true);
					yield* record(
						"session.workspace_changed",
						{},
						{
							sessionId: "session",
							cause: "agent",
							worktrees: {},
							origin: "existing",
						},
					);
					expect(
						(yield* workspace.claudeWorktreeState("session")).pendingUserMove,
					).toBe(false);
				}),
			),
	);
});
