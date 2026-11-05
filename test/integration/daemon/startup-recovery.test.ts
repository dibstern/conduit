// What a project's startup recovers from a store an earlier daemon left
// behind: historical sessions, and Claude approvals a crash left pending.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { projectSessionManager } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

/** Starts a project on a store the seed wrote before the daemon ran. */
async function withSeededProject<A>(
	slug: string,
	seed: Effect.Effect<void, unknown, EventStoreEffectTag | ReadQueryEffectTag>,
	body: (project: DaemonProject) => Promise<A>,
): Promise<A> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sr-")));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	await Effect.runPromise(
		seed.pipe(
			Effect.provide(
				makePersistenceEffectLayer(join(configDir, "events.db"), slug),
				{ local: true },
			),
		),
	);
	const project = await createDaemonProject("chat-simple", {
		configDir,
		slug,
	});
	try {
		return await body(project);
	} finally {
		await project.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

it("recovers historical sessions before startup can create a live session", async () => {
	const seed = Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		yield* store.append(
			canonicalEvent(
				"session.created",
				"historical",
				{ sessionId: "historical", title: "Historical", provider: "claude" },
				{ provider: "claude" },
			),
		);
		const query = yield* ReadQueryEffectTag;
		expect(
			yield* query.listSessions({ projectIds: ["startup-recovery"] }),
		).toEqual([]);
	});
	const sessions = await withSeededProject(
		"startup-recovery",
		seed,
		(project) =>
			project.run(
				Effect.gen(function* () {
					const manager = yield* projectSessionManager;
					const live = yield* manager.createSession("Live", {
						pick: {
							harness: "claude",
							model: { providerId: "claude", modelId: "sonnet" },
							effort: "",
							contextWindow: "",
						},
					});
					const rows = yield* manager.listSessions();
					return { liveId: live.id, ids: rows.map((row) => row.id) };
				}),
			),
	);
	expect(sessions.ids).toContain("historical");
	expect(sessions.ids).toContain(sessions.liveId);
});

// Runner recovery retires every prompt an unclaimed Claude session left pending,
// questions too: the process that asked is gone (provider-process-expired).
it("retires the prompts a crash left pending on Claude sessions and leaves OpenCode's alone", async () => {
	const seed = (provider: "claude" | "opencode") =>
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const sessionId = `${provider}-session`;
			yield* store.append(
				canonicalEvent(
					"session.created",
					sessionId,
					{ sessionId, title: provider, provider },
					{ provider },
				),
			);
			yield* store.append(
				canonicalEvent(
					"permission.asked",
					sessionId,
					{
						id: `${provider}-permission`,
						sessionId,
						toolName: "Bash",
						input: { command: "ls" },
					},
					{ provider },
				),
			);
			yield* store.append(
				canonicalEvent(
					"question.asked",
					sessionId,
					{ id: `${provider}-question`, sessionId, questions: [] },
					{ provider },
				),
			);
		});
	await withSeededProject(
		"orphaned-permissions",
		Effect.all([seed("claude"), seed("opencode")], { discard: true }),
		(project) =>
			vi.waitFor(async () =>
				expect(
					await project.run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql`
								SELECT id, status, decision FROM pending_approvals ORDER BY id`;
						}),
					),
				).toEqual([
					{ id: "claude-permission", status: "resolved", decision: "reject" },
					{ id: "claude-question", status: "resolved", decision: "{}" },
					{ id: "opencode-permission", status: "pending", decision: null },
					{ id: "opencode-question", status: "pending", decision: null },
				]),
			),
	);
});
