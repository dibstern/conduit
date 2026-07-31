import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	OpenCodeInstanceClientsLive,
	OpenCodeInstanceClientsTag,
} from "../../../src/lib/domain/relay/Services/opencode-instance-clients.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("OpenCodeInstanceClients", () => {
	it("fails promptly when a named instance server is unreachable", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "opencode-instance-clients-"));
		tempDirs.push(configDir);
		const daemonConfig: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances: [
				{
					id: "work-oc",
					name: "Work OpenCode",
					port: 0,
					managed: false,
					driver: "opencode",
					url: "http://named-instance.invalid",
				},
			],
		};
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify(daemonConfig));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED");
			}),
		);

		const layer = OpenCodeInstanceClientsLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(
						ConfigTag,
						makeMockConfig({
							configDir,
							projectDir: "/test/project",
						}),
					),
					Layer.succeed(LoggerTag, makeMockLogger()),
				),
			),
		);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const clients = yield* OpenCodeInstanceClientsTag;
					yield* clients.registerStreamWirer(() => Effect.void);
					return yield* Effect.either(clients.clientFor("work-oc"));
				}).pipe(Effect.provide(layer)),
			),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left.message).toContain("ECONNREFUSED");
		}
	}, 8_000);

	it("holds the connect window open across a transport error and connects on retry", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "opencode-instance-clients-"));
		tempDirs.push(configDir);
		const daemonConfig: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances: [
				{
					id: "work-oc",
					name: "Work OpenCode",
					port: 0,
					managed: false,
					driver: "opencode",
					url: "http://named-instance.invalid",
				},
			],
		};
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify(daemonConfig));

		// OpenCode is up (REST answers), but the first SSE connect dies with a
		// transport error. Conduit owns reconnection: the retry inside the 4s
		// window must succeed rather than the first error aborting startup.
		let eventCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes("/event")) {
					eventCalls++;
					if (eventCalls === 1) throw new Error("read ECONNRESET");
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
									),
								);
								// Stay open; the drain finalizer aborts the reader.
							},
						}),
						{ status: 200, headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return new Response(
					JSON.stringify({
						state: "/test/state",
						config: "/test/config",
						worktree: "/test",
						directory: "/test",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const layer = OpenCodeInstanceClientsLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(
						ConfigTag,
						makeMockConfig({
							configDir,
							projectDir: "/test/project",
						}),
					),
					Layer.succeed(LoggerTag, makeMockLogger()),
				),
			),
		);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const clients = yield* OpenCodeInstanceClientsTag;
					yield* clients.registerStreamWirer(() => Effect.void);
					return yield* Effect.either(clients.clientFor("work-oc"));
				}).pipe(Effect.provide(layer)),
			),
		);

		expect(eventCalls).toBeGreaterThanOrEqual(2);
		expect(result._tag).toBe("Right");
	}, 8_000);
});
