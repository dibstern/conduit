import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Deferred, Effect, Result as Either, Fiber } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeOpenCodeInstancesLive,
	type OpenCodeEndpoint,
} from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import {
	OpenCodeControlTarget,
	OpenCodeInstancesTag,
} from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { openCodePromptProcessId } from "../../../src/lib/provider/opencode-process-identity.js";

// Failure cases: concurrent first uses spawning twice, a joiner getting a
// client before the spawn finished, and a failed start being cached so every
// later use fails without retrying.
describe("OpenCode Instances shared start", () => {
	const results: Record<string, unknown>[] = [];
	let server: Server;
	let url: string;
	let endpoint: OpenCodeEndpoint;
	let starts: number;
	let replies: number;
	let health: { status: number; body: string };
	let holdHealth: boolean;
	let healthRequested: Deferred.Deferred<ServerResponse>;
	let streamOpened: Deferred.Deferred<{
		stream: ServerResponse;
		closed: Deferred.Deferred<void>;
	}>;
	let connectStream: boolean;
	let streams: ServerResponse[];
	let requests: {
		url: string;
		authorization: string | undefined;
		directoryHeader: string | string[] | undefined;
	}[];

	beforeEach(async () => {
		health = { status: 200, body: JSON.stringify({ healthy: true }) };
		holdHealth = false;
		healthRequested = Deferred.makeUnsafe();
		streamOpened = Deferred.makeUnsafe();
		connectStream = true;
		streams = [];
		requests = [];
		// Minimal OpenCode: path, health and a live global event stream.
		server = createServer((req, res) => {
			requests.push({
				url: req.url ?? "",
				authorization: req.headers.authorization,
				directoryHeader: req.headers["x-opencode-directory"],
			});
			if (req.url?.includes("/permissions/") && req.method === "POST") {
				replies++;
				res.writeHead(200, { "content-type": "application/json" });
				res.end("true");
				return;
			}
			if (req.url?.startsWith("/global/event")) {
				streams.push(res);
				const closed = Deferred.makeUnsafe<void>();
				res.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.flushHeaders();
				Deferred.doneUnsafe(
					streamOpened,
					Effect.succeed({ stream: res, closed }),
				);
				if (!connectStream) return;
				res.write(
					`data: ${JSON.stringify({ payload: { id: "1", type: "server.connected", properties: {} } })}\n\n`,
				);
				return;
			}
			if (req.url?.startsWith("/global/health")) {
				Deferred.doneUnsafe(healthRequested, Effect.succeed(res));
				if (holdHealth) return;
				res.writeHead(health.status, { "content-type": "application/json" });
				res.end(health.body);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					req.url?.startsWith("/path")
						? { state: "/", config: "/", worktree: "/", directory: "/race" }
						: [],
				),
			);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (typeof address !== "object" || address == null)
			throw new Error("Expected TCP server address");
		url = `http://127.0.0.1:${address.port}`;
		endpoint = { url, status: "stopped", managed: true };
		starts = 0;
		replies = 0;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});

	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/pa3r-7-start-race.json",
			JSON.stringify(
				{
					ticket: "conduit-test-pa3r.7",
					at: new Date().toISOString(),
					results,
				},
				null,
				2,
			),
		);
		writeFileSync(
			"/tmp/82tn27-2-opencode-selection.json",
			JSON.stringify(results, null, 2),
		);
	});

	/** A managed instance whose spawn takes 300ms and fails while `failures` lasts. */
	const instances = (failures = 0) =>
		makeOpenCodeInstancesLive(() => Effect.sync(() => endpoint), {
			control: {
				start: () =>
					Effect.gen(function* () {
						starts++;
						yield* Effect.sleep("300 millis");
						if (starts <= failures) return yield* Effect.fail("spawn crashed");
						endpoint = { ...endpoint, status: "healthy" };
					}),
				stop: () => Effect.succeed(false),
				adopted: Effect.succeed([]),
			},
		});

	const cwdViaUse = Effect.flatMap(OpenCodeInstancesTag, ({ use }) =>
		Effect.scoped(
			Effect.flatMap(use("opencode"), (client) =>
				Effect.promise(() => client.app.path()),
			),
		),
	).pipe(
		Effect.map(({ cwd }) => cwd),
		Effect.result,
	);

	for (const acquisition of ["use", "borrow"] as const) {
		for (const state of ["stopped", "replacement", "matching"] as const) {
			it(`${acquisition} delivers controls only to the matching process: ${state}`, async () => {
				endpoint = {
					...endpoint,
					status: state === "stopped" ? "stopped" : "healthy",
					processIdentity: state === "replacement" ? "replacement" : "original",
				};
				const outcome = await Effect.runPromise(
					Effect.gen(function* () {
						const owner = yield* OpenCodeInstancesTag;
						const client = yield* owner[acquisition]("opencode");
						yield* Effect.tryPromise(() =>
							client.permission.reply("session-1", "perm-1", "once"),
						);
					}).pipe(
						Effect.scoped,
						Effect.provideService(
							OpenCodeControlTarget,
							openCodePromptProcessId("opencode", "original"),
						),
						Effect.result,
						Effect.provide(instances()),
					),
				);
				const result = {
					scenario: `fenced-${acquisition}-${state}`,
					starts,
					replies,
					failure: Either.isFailure(outcome) ? outcome.failure : undefined,
				};
				results.push(result);
				expect(result).toMatchObject({
					starts: 0,
					replies: state === "matching" ? 1 : 0,
					failure:
						state === "matching"
							? undefined
							: { reason: "not-running", code: "provider_process_gone" },
				});
			});
		}
	}

	it("marks only clients with managed process identity safe for restart replay", async () => {
		endpoint = { ...endpoint, status: "healthy", processIdentity: "original" };
		const clients = await Effect.runPromise(
			Effect.gen(function* () {
				const owner = yield* OpenCodeInstancesTag;
				const managed = yield* owner.use("opencode");
				endpoint = { url, status: "healthy", managed: false };
				const external = yield* owner.use("opencode");
				return {
					managed: managed.controlReplaySafe,
					external: external.controlReplaySafe,
				};
			}).pipe(Effect.scoped, Effect.provide(instances())),
		);
		results.push({ scenario: "restart-replay-identity", ...clients });
		expect(clients).toEqual({ managed: true, external: false });
	});

	it("checks authenticated global health, waits for the stream and returns a directory client", async () => {
		connectStream = false;
		endpoint = {
			...endpoint,
			managed: false,
			status: "healthy",
			auth: { username: "readiness", password: "fixture-password" },
		};
		const cwd = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { use } = yield* OpenCodeInstancesTag;
					const pending = yield* Effect.forkChild(use("opencode", "/project"));
					yield* Deferred.await(healthRequested);
					const { stream } = yield* Deferred.await(streamOpened);
					yield* Effect.sync(() => {
						expect(streams).toHaveLength(1);
						expect(stream.headersSent).toBe(true);
						expect(stream.destroyed).toBe(false);
						expect(pending.pollUnsafe()).toBeUndefined();
						stream.write(
							`data: ${JSON.stringify({ payload: { id: "1", type: "server.connected", properties: {} } })}\n\n`,
						);
					});
					const client = yield* Fiber.join(pending);
					return yield* Effect.tryPromise(() => client.app.path());
				}),
			).pipe(Effect.provide(instances())),
		);
		const authorization = `Basic ${Buffer.from("readiness:fixture-password").toString("base64")}`;
		expect(cwd.cwd).toBe("/race");
		expect(starts).toBe(0);
		expect(requests.filter(({ url }) => url === "/global/health")).toEqual([
			{ url: "/global/health", authorization, directoryHeader: undefined },
		]);
		expect(requests.find(({ url }) => url.startsWith("/global/event"))).toEqual(
			{
				url: "/global/event",
				authorization,
				directoryHeader: undefined,
			},
		);
		const pathRequest = requests.find(({ url }) => url.startsWith("/path"));
		expect(pathRequest?.authorization).toBe(authorization);
		expect(
			new URL(pathRequest?.url ?? "", url).searchParams.get("directory"),
		).toBe("/project");
		results.push({ scenario: "global-readiness", cwd, starts, requests });
	});

	it.each([
		{ name: "unhealthy", status: 200, body: '{"healthy":false}' },
		{ name: "array", status: 200, body: "[]" },
		{ name: "non-boolean health", status: 200, body: '{"healthy":"true"}' },
		{ name: "malformed JSON", status: 200, body: "garbage" },
		{ name: "HTTP failure", status: 401, body: '{"healthy":true}' },
	])("rejects $name health and closes the new stream", async (response) => {
		health = response;
		holdHealth = true;
		connectStream = false;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { use } = yield* OpenCodeInstancesTag;
					const pending = yield* Effect.forkChild(
						Effect.result(use("opencode")),
					);
					const healthResponse = yield* Deferred.await(healthRequested);
					const { stream, closed } = yield* Deferred.await(streamOpened);
					yield* Effect.sync(() => {
						expect(streams).toHaveLength(1);
						expect(stream.headersSent).toBe(true);
						expect(stream.destroyed).toBe(false);
						expect(pending.pollUnsafe()).toBeUndefined();
						healthResponse.writeHead(health.status, {
							"content-type": "application/json",
						});
						healthResponse.end(health.body);
					});
					const outcome = yield* Fiber.join(pending);
					// Both the consumer scope and instances layer stay alive here.
					yield* Effect.sync(() => {
						expect(Either.isFailure(outcome) && outcome.failure.reason).toBe(
							"unreachable",
						);
						expect(
							requests.filter(({ url }) => url === "/global/health"),
						).toHaveLength(1);
						expect(requests.some(({ url }) => url.startsWith("/path"))).toBe(
							false,
						);
					});
					yield* Deferred.await(closed);
					yield* Effect.sync(() => {
						expect(stream.destroyed).toBe(true);
						expect(streams).toHaveLength(1);
						results.push({
							scenario: `reject-${response.name}`,
							outcome,
							requests,
							streamsClosed: stream.destroyed,
						});
					});
				}),
			).pipe(Effect.provide(instances())),
		);
	});

	it("spawns once for concurrent first uses and gives both a working client", async () => {
		const outcomes = await Effect.runPromise(
			Effect.all([cwdViaUse, cwdViaUse], { concurrency: "unbounded" }).pipe(
				Effect.provide(instances()),
			),
		);
		const result = {
			scenario: "concurrent-first-use",
			starts,
			outcomes: outcomes.map((outcome) =>
				Either.isSuccess(outcome) ? outcome.success : outcome.failure.reason,
			),
		};
		results.push(result);
		expect(result).toEqual({
			scenario: "concurrent-first-use",
			starts: 1,
			outcomes: ["/race", "/race"],
		});
	});

	it("does not cache a failed start: the next use retries and succeeds", async () => {
		const outcomes = await Effect.runPromise(
			Effect.gen(function* () {
				const failed = yield* cwdViaUse;
				const startsAfterFailure = starts;
				const retried = yield* cwdViaUse;
				return { failed, startsAfterFailure, retried };
			}).pipe(Effect.provide(instances(1))),
		);
		const result = {
			scenario: "retry-after-failed-start",
			startsAfterFailure: outcomes.startsAfterFailure,
			starts,
			failed: Either.isFailure(outcomes.failed)
				? outcomes.failed.failure.reason
				: outcomes.failed.success,
			retried: Either.isSuccess(outcomes.retried)
				? outcomes.retried.success
				: outcomes.retried.failure.reason,
		};
		results.push(result);
		expect(result).toEqual({
			scenario: "retry-after-failed-start",
			startsAfterFailure: 1,
			starts: 2,
			failed: "spawn-failed",
			retried: "/race",
		});
	});
});
