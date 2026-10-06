import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Effect, Either } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeOpenCodeInstancesLive,
	type OpenCodeEndpoint,
} from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";

// Failure cases: concurrent first uses spawning twice, a joiner getting a
// client before the spawn finished, and a failed start being cached so every
// later use fails without retrying.
describe("OpenCode Instances shared start", () => {
	const results: Record<string, unknown>[] = [];
	let server: Server;
	let url: string;
	let endpoint: OpenCodeEndpoint;
	let starts: number;

	beforeEach(async () => {
		// Minimal OpenCode: path, health and a live global event stream.
		server = createServer((req, res) => {
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
						? { state: "/", config: "/", worktree: "/", directory: "/race" }
						: req.url?.startsWith("/global/health")
							? { healthy: true }
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
				stop: () => Effect.void,
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
		Effect.either,
	);

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
				Either.isRight(outcome) ? outcome.right : outcome.left.reason,
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
			failed: Either.isLeft(outcomes.failed)
				? outcomes.failed.left.reason
				: outcomes.failed.right,
			retried: Either.isRight(outcomes.retried)
				? outcomes.retried.right
				: outcomes.retried.left.reason,
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
