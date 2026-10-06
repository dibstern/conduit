import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
	Deferred,
	Effect,
	Fiber,
	Option,
	TestClock,
	TestContext,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	makeOpenCodeInstancesLive,
	type OpenCodeEndpoint,
} from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";

// Failure case: a `use` that arrives while an idle stop is terminating the
// process gets a client for the dying process instead of waiting for the stop
// and starting again.
describe("OpenCode Instances use during an idle stop", () => {
	const servers: Server[] = [];

	/** Minimal OpenCode whose /path reports `directory`. */
	const serve = async (directory: string) => {
		const server = createServer((req, res) => {
			if (req.url?.startsWith("/global/event")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`data: ${JSON.stringify({ payload: { id: "1", type: "server.connected", properties: {} } })}\n\n`,
				);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					req.url?.startsWith("/path")
						? { state: "/", config: "/", worktree: "/", directory }
						: req.url?.startsWith("/session/status")
							? {}
							: [],
				),
			);
		});
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (typeof address !== "object" || address == null)
			throw new Error("Expected TCP server address");
		return { server, url: `http://127.0.0.1:${address.port}` };
	};

	const close = (server: Server) =>
		new Promise<void>((done) => {
			server.closeAllConnections();
			server.close(() => done());
		});

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => close(server)));
	});

	it("waits for the stop, then gets the restarted process's client", async () => {
		const dying = await serve("/dying");
		const restarted = await serve("/restarted");
		let endpoint: OpenCodeEndpoint = {
			url: dying.url,
			status: "stopped",
			managed: true,
		};
		let starts = 0;
		let stops = 0;
		const timeline: string[] = [];
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stopBegan = yield* Deferred.make<void>();
				const layer = makeOpenCodeInstancesLive(
					() => Effect.sync(() => endpoint),
					{
						idleTimeoutMs: 1_000,
						control: {
							start: () =>
								Effect.sync(() => {
									starts++;
									endpoint = {
										url: starts === 1 ? dying.url : restarted.url,
										status: "healthy",
										managed: true,
									};
								}),
							// Terminating the process takes 300ms of (test) time.
							stop: () =>
								Effect.gen(function* () {
									stops++;
									timeline.push("stop-begin");
									yield* Deferred.succeed(stopBegan, undefined);
									yield* Effect.sleep("300 millis");
									yield* Effect.promise(() => close(dying.server));
									endpoint = { ...endpoint, status: "stopped" };
									timeline.push("stop-end");
								}),
							adopted: Effect.succeed([]),
						},
					},
				);
				const cwdViaUse = Effect.flatMap(OpenCodeInstancesTag, ({ use }) =>
					Effect.scoped(
						Effect.flatMap(use("opencode"), (client) =>
							Effect.promise(() => client.app.path()),
						),
					),
				).pipe(
					Effect.map(({ cwd }) => cwd),
					Effect.tap(() => Effect.sync(() => timeline.push("use-resolved"))),
				);
				return yield* Effect.gen(function* () {
					const first = yield* cwdViaUse;
					// No demand: the grace runs out and the idle stop begins.
					yield* TestClock.adjust("1 second");
					yield* Deferred.await(stopBegan);
					const during = yield* Effect.fork(cwdViaUse);
					yield* Effect.promise(
						() => new Promise((done) => setTimeout(done, 200)),
					);
					const pendingDuringStop = Option.isNone(yield* Fiber.poll(during));
					yield* TestClock.adjust("300 millis");
					const second = yield* Fiber.join(during);
					return { first, pendingDuringStop, second };
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
		const evidence = {
			scenario: "use-during-idle-stop",
			...result,
			starts,
			stops,
			timeline,
		};
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/pa3r-8-stop-race.json",
			JSON.stringify(
				{
					ticket: "conduit-test-pa3r.8",
					at: new Date().toISOString(),
					evidence,
				},
				null,
				2,
			),
		);
		expect(evidence).toEqual({
			scenario: "use-during-idle-stop",
			first: "/dying",
			pendingDuringStop: true,
			second: "/restarted",
			starts: 2,
			stops: 1,
			timeline: ["use-resolved", "stop-begin", "stop-end", "use-resolved"],
		});
	});
});
