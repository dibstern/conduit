/*
 * Default-account RPC failure modes:
 * - Moving the default must persist before replying and update both clients.
 * - Session-list subscribers must be invalidated by the same mutation.
 * - Unknown and OpenCode accounts must fail with a typed rejection.
 * All config, account folders and environment variables are fixture-owned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Layer, Queue, Stream } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AccountChangeRejected } from "../../../src/lib/contracts/account.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

let root: string;
const evidence: Array<{ name: string; result: string | undefined }> = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-default-account-"));
	for (const folder of ["home", "launch", "original", "personal"]) {
		mkdirSync(join(root, folder));
	}
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", root);
});
afterEach(({ task }) => {
	vi.unstubAllEnvs();
	evidence.push({ name: task.name, result: task.result?.state });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/g4zp-8-rpc.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	rmSync(root, { recursive: true, force: true });
});

const fixture = () =>
	makeDaemonRpcTestLayer([], undefined, {
		configDir: root,
		launchLogin: configuredClaudeConfigDir(join(root, "launch")),
		instances: [
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				configDir: join(root, "original"),
				port: 0,
				managed: false,
			},
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				configDir: join(root, "personal"),
				port: 0,
				managed: false,
			},
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 4099,
				managed: false,
			},
		],
		persistence: ConfigPersistenceLive.pipe(
			Layer.provide(
				Layer.merge(
					ConfigSnapshotFromEffectStateLive,
					makeConfigWriterLive(root),
				),
			),
		),
	});

const makeClient = Effect.gen(function* () {
	const handlers = yield* DaemonWsRpcHandlersTag;
	return yield* RpcTest.makeClient(WsRpcGroup).pipe(
		Effect.provide(
			makeRoutedWsRpcServerLayer(
				() => Effect.die("Unexpected project routing"),
				handlers,
			),
		),
	);
});

describe("default Claude account through daemon RPC", () => {
	it.scoped(
		"persists the pointer and refreshes two clients and session subscribers",
		() =>
			Effect.gen(function* () {
				const first = yield* makeClient;
				const second = yield* makeClient;
				const lists = [
					yield* Queue.unbounded<
						readonly {
							readonly id: string;
							readonly isDefault?: boolean | undefined;
						}[]
					>(),
					yield* Queue.unbounded<
						readonly {
							readonly id: string;
							readonly isDefault?: boolean | undefined;
						}[]
					>(),
				];
				for (const [client, list] of [
					[first, lists[0]],
					[second, lists[1]],
				] as const) {
					if (!list) throw new Error("Missing client queue");
					yield* Stream.runForEach(client.SubscribeInstances({}), (snapshot) =>
						Queue.offer(list, snapshot.instances),
					).pipe(Effect.forkScoped);
					expect(
						(yield* Queue.take(list))
							.filter((item) => item.isDefault)
							.map((item) => item.id),
					).toEqual(["claude", "opencode"]);
				}
				const statuses = yield* Queue.unbounded<void>();
				yield* Stream.runForEach(second.SubscribeServerStatus({}), () =>
					Queue.offer(statuses, undefined),
				).pipe(Effect.forkScoped);
				yield* Queue.take(statuses);
				const reply = yield* first.SetDefault({ instanceId: "personal" });
				expect(
					reply.instances
						.filter((item) => item.driver === "claude" && item.isDefault)
						.map((item) => item.id),
				).toEqual(["personal"]);
				for (const list of lists) {
					if (!list) throw new Error("Missing client queue");
					expect(
						(yield* Queue.take(list))
							.filter((item) => item.isDefault)
							.map((item) => item.id),
					).toEqual(["personal", "opencode"]);
				}
				yield* Queue.take(statuses);
				const stored = Either.getOrThrowWith(
					loadDaemonConfigResult(root),
					(error) => error,
				);
				expect(stored?.accountDefaults?.claude).toBe("personal");
			}).pipe(Effect.provide(fixture()), Effect.timeout("10 seconds")),
	);

	it.scoped(
		"rejects unknown and OpenCode defaults without moving the pointer",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				for (const instanceId of ["missing", "opencode"]) {
					const result = yield* Effect.either(
						client.SetDefault({ instanceId }),
					);
					expect(Either.isLeft(result)).toBe(true);
					if (Either.isLeft(result))
						expect(result.left).toBeInstanceOf(AccountChangeRejected);
				}
				const initial = yield* Stream.runHead(client.SubscribeInstances({}));
				expect(
					initial._tag === "Some" &&
						initial.value.instances.find((item) => item.id === "claude")
							?.isDefault,
				).toBe(true);
			}).pipe(Effect.provide(fixture())),
	);
});
