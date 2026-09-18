import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	applySessionCommand,
	createOpenCodeSession,
	forkOpenCodeSession,
	SessionCommandError,
} from "../../../src/lib/domain/relay/Services/session-command.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type EffectProjector,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

// The seam's contract: append the canonical event, project it strictly, then
// sync upstream best-effort. These tests pin the parts a caller cannot see —
// which upstream gets told, and which failures are allowed to escape.
describe("applySessionCommand", () => {
	const makeMockApi = () => ({
		session: {
			list: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "s-new", title: "New" })),
			delete: vi.fn(async () => undefined),
			update: vi.fn(async () => undefined),
			fork: vi.fn(async () => ({ id: "ses-fork", title: "Forked" })),
		},
	});

	const withHarness = <A, E>(
		use: (harness: {
			readonly api: ReturnType<typeof makeMockApi>;
			readonly log: ReturnType<typeof makeMockLogger>;
		}) => Effect.Effect<
			A,
			E,
			SqlClient.SqlClient | ProjectionRunnerEffectTag | OpenCodeAPITag
		>,
		projectors?: readonly EffectProjector[],
	) => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-session-command-"));
		const api = makeMockApi();
		const log = makeMockLogger();
		const persistenceLayer = makePersistenceEffectLayer(join(dir, "events.db"));

		return use({ api, log }).pipe(
			Effect.provide(
				Layer.mergeAll(
					persistenceLayer,
					Layer.succeed(OpenCodeAPITag, api as unknown as OpenCodeAPI),
					Layer.succeed(LoggerTag, log),
					// An empty config dir keeps provider routing at its defaults instead
					// of reading the developer's real ~/.config/conduit.
					Layer.succeed(ConfigTag, makeMockConfig({ configDir: dir })),
					...(projectors
						? [
								Layer.effect(
									ProjectionRunnerEffectTag,
									makeProjectionRunnerEffect(projectors),
								).pipe(Layer.provide(persistenceLayer)),
							]
						: []),
				),
			),
			Effect.ensuring(
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		);
	};

	const seedSession = (sessionId: string, provider: string) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.markRecovered();
			yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES (${sessionId}, ${provider}, 'Doomed', 'idle', 1000, 1000)`;
		});

	const sessionIds = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ id: string }>`SELECT id FROM sessions`;
		return rows.map((row) => row.id);
	});

	const eventTypes = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ type: string }>`SELECT type FROM events`;
		return rows.map((row) => row.type);
	});

	it.effect(
		"tells OpenCode about a mutation to an OpenCode-backed session",
		() =>
			withHarness(({ api }) =>
				Effect.gen(function* () {
					yield* seedSession("ses-opencode", "opencode");

					yield* applySessionCommand({
						type: "session.deleted",
						data: { sessionId: "ses-opencode" },
					});

					expect(yield* eventTypes).toEqual(["session.deleted"]);
					expect(yield* sessionIds).toEqual([]);
					expect(api.session.delete).toHaveBeenCalledWith("ses-opencode");
				}),
			),
	);

	it.effect("leaves upstream alone for a Claude-backed session", () =>
		withHarness(({ api }) =>
			Effect.gen(function* () {
				yield* seedSession("ses-claude", "claude-sdk");

				yield* applySessionCommand({
					type: "session.deleted",
					data: { sessionId: "ses-claude" },
				});

				expect(yield* sessionIds).toEqual([]);
				// The Claude Agent SDK has no session registry, so there is nothing to
				// tell — and telling OpenCode would delete an unrelated session.
				expect(api.session.delete).not.toHaveBeenCalled();
			}),
		),
	);

	it.effect("logs a failed upstream sync instead of failing the command", () =>
		withHarness(({ api, log }) =>
			Effect.gen(function* () {
				yield* seedSession("ses-opencode", "opencode");
				api.session.delete.mockRejectedValueOnce(new Error("upstream down"));

				yield* applySessionCommand({
					type: "session.deleted",
					data: { sessionId: "ses-opencode" },
				});

				// The local write is authoritative: the session is gone regardless.
				expect(yield* sessionIds).toEqual([]);
				expect(log.warn).toHaveBeenCalledWith(
					"Upstream session sync failed",
					expect.objectContaining({
						operation: "session.deleted",
						sessionId: "ses-opencode",
					}),
				);
			}),
		),
	);

	it.effect("fails the command when the projection fails", () => {
		const rootCause = new Error("delete projection exploded");
		const failingProjector: EffectProjector = {
			name: "failing-session-projector",
			handles: ["session.deleted"],
			project: () =>
				Effect.fail(
					new ProjectionError({
						projector: "failing-session-projector",
						operation: "project",
						cause: rootCause,
					}),
				),
		};

		return withHarness(
			({ api }) =>
				Effect.gen(function* () {
					yield* seedSession("ses-opencode", "opencode");

					const result = yield* Effect.either(
						applySessionCommand({
							type: "session.deleted",
							data: { sessionId: "ses-opencode" },
						}),
					);

					// conduit-test-42k7: the caller must not be told a delete worked
					// while the row it reads back is still there.
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left).toBeInstanceOf(SessionCommandError);
						// Append and project are one transaction, so the failure names the
						// commit that rolled back, not a separate project step.
						expect(result.left.operation).toBe("session.deleted.commit");
						expect(result.left.cause).toBeInstanceOf(ProjectionRunnerError);
					}
					expect(yield* sessionIds).toEqual(["ses-opencode"]);
					expect(api.session.delete).not.toHaveBeenCalled();
				}),
			[failingProjector],
		);
	});

	it.effect("records the session it creates upstream", () =>
		withHarness(({ api }) =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				const session = yield* createOpenCodeSession("New", "opencode");

				expect(api.session.create).toHaveBeenCalledWith({ title: "New" });
				// Creating a session upstream and recording nothing locally is the
				// shape of conduit-test-42k7. Folding the command into the same
				// function is what makes it unrepresentable from outside the seam.
				expect(yield* eventTypes).toEqual(["session.created"]);
				expect(yield* sessionIds).toEqual([session.id]);
			}),
		),
	);

	it.effect("gives a forked session a row to carry its lineage", () =>
		withHarness(({ api }) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("ses-parent", "opencode");

				const forked = yield* forkOpenCodeSession("ses-parent", "msg-7");

				expect(api.session.fork).toHaveBeenCalledWith("ses-parent", {
					messageID: "msg-7",
				});

				// The row has to exist before lineage can land on it: session.forked
				// projects as an UPDATE, and an UPDATE that matches nothing reports
				// success. That is conduit-test-o5vp — the fork was recorded upstream
				// and in the sidecar, and showed up in the sidebar as a root session.
				yield* applySessionCommand({
					type: "session.forked",
					data: {
						sessionId: forked.id,
						parentId: "ses-parent",
						forkPointEvent: "msg-7",
					},
				});

				expect(
					yield* sql<{
						id: string;
						provider: string;
						parent_id: string | null;
						fork_point_event: string | null;
					}>`SELECT id, provider, parent_id, fork_point_event
					   FROM sessions WHERE id = ${forked.id}`,
				).toEqual([
					{
						id: "ses-fork",
						// Inherited from the parent, not assumed.
						provider: "opencode",
						parent_id: "ses-parent",
						fork_point_event: "msg-7",
					},
				]);
			}),
		),
	);

	it.effect("still syncs upstream for a session with no local row", () =>
		withHarness(({ api }) =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* applySessionCommand({
					type: "session.deleted",
					data: { sessionId: "ses-unknown" },
				});

				// Nothing to record locally, but upstream may still be holding it.
				expect(yield* eventTypes).toEqual([]);
				expect(api.session.delete).toHaveBeenCalledWith("ses-unknown");
			}),
		),
	);
});
