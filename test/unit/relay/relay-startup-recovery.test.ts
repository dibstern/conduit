import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";

it("recovers historical sessions before startup can create a live session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-startup-recovery-"));
	const filename = join(dir, "events.db");
	const server = createServer();
	let relay: ProjectRelay | undefined;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		const path = new URL(request.url).pathname;
		if (path === "/event") return new Response(null, { status: 503 });
		return Response.json(
			path === "/path"
				? { state: dir, config: dir, worktree: dir, directory: dir }
				: path === "/session"
					? []
					: {},
		);
	});
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* store.append(
					canonicalEvent(
						"session.created",
						"historical",
						{
							sessionId: "historical",
							title: "Historical",
							provider: "claude",
						},
						{ provider: "claude" },
					),
				);
				const query = yield* ReadQueryEffectTag;
				expect(yield* query.listSessions()).toEqual([]);
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);

		relay = await createProjectRelay({
			httpServer: server,
			opencodeUrl: "http://opencode.test",
			projectDir: dir,
			slug: "startup-recovery",
			configDir: dir,
			persistenceDbPath: filename,
			log: createSilentLogger(),
		});
		const sessions = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const manager = yield* SessionManagerServiceTag;
				const live = yield* manager.createSession("Live");
				const rows = yield* manager.listSessions();
				return { liveId: live.id, ids: rows.map((row) => row.id) };
			}),
		);
		expect(sessions.ids).toContain("historical");
		expect(sessions.ids).toContain(sessions.liveId);
		expect(relay.initialSessionId).toBe("historical");
	} finally {
		await relay?.stop();
		server.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});
