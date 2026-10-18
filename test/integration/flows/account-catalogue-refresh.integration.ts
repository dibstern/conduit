/*
 * Catalogue refresh failures at the daemon and project RPC boundaries:
 * - A pending old-account discovery must not suppress the new default's read.
 * - Repeated reads of the same account must share the pending discovery.
 * - Late discoveries and CreateSession validation must identify their account,
 *   so clients can keep explicit picks while another account's catalogue changes.
 * The provider is fake; all daemon and relay state and folders are isolated.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AccountSchema } from "../../../src/lib/contracts/account.js";
import {
	type ProjectSetting,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { ProviderCapabilities } from "../../../src/lib/provider/types.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	makeRoutedWsRpcServerLayer,
	WsRpcServerLayer,
} from "../../../src/lib/server/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

type Catalogue = Extract<ProjectSetting, { _tag: "providerModels" }>;
let root: string;
const evidence: Array<{ name: string; result: string | undefined }> = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "g4zp8-catalogues-"));
	for (const folder of ["home", "launch", "original", "personal"])
		mkdirSync(join(root, folder));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", root);
});
afterEach(({ task }) => {
	vi.unstubAllEnvs();
	evidence.push({ name: task.name, result: task.result?.state });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/g4zp-8-catalogues.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	rmSync(root, { recursive: true, force: true });
});

const daemonLayer = () =>
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
		],
	});

const capabilities = (account: string): ProviderCapabilities => ({
	models: [
		{ id: `${account}-model`, name: `${account} model`, providerId: "claude" },
	],
	commands: [],
	supportsTools: true,
	supportsThinking: true,
	supportsPermissions: true,
	supportsQuestions: true,
	supportsAttachments: true,
	supportsFork: true,
	supportsRevert: true,
});

const clients = (pendingOriginal?: Deferred.Deferred<ProviderCapabilities>) =>
	Effect.gen(function* () {
		const directory = yield* AccountDirectory;
		const started = yield* Queue.unbounded<string>();
		const engine = withDispatchEffect({
			dispatchEffect: (command: unknown) =>
				Effect.gen(function* () {
					if (
						!isRecord(command) ||
						command["type"] !== "discover" ||
						typeof command["providerId"] !== "string"
					)
						return yield* Effect.die("Unexpected provider operation");
					const account =
						command["account"] !== undefined
							? Schema.decodeUnknownSync(AccountSchema)(command["account"])
							: yield* directory.resolve({
									_tag: "Id",
									id: command["providerId"],
								});
					yield* Queue.offer(started, account.id);
					return account.id === "claude" && pendingOriginal
						? yield* Deferred.await(pendingOriginal)
						: capabilities(account.id);
				}),
		});
		const relay = yield* Layer.build(
			makeTestHandlerLayer({
				accountDirectory: directory,
				orchestrationEngine: engine,
				config: makeMockConfig({
					projectDir: root,
					configDir: root,
					slug: "myapp",
				}),
			}),
		);
		const project = yield* RpcTest.makeClient(WsRpcGroup).pipe(
			Effect.provide(WsRpcServerLayer),
			Effect.provide(relay),
		);
		const handlers = yield* DaemonWsRpcHandlersTag;
		const daemon = yield* RpcTest.makeClient(WsRpcGroup).pipe(
			Effect.provide(
				makeRoutedWsRpcServerLayer(
					() => Effect.die("Unexpected project routing"),
					handlers,
				),
			),
		);
		const published = yield* Queue.unbounded<Catalogue>();
		const subscribed = yield* Deferred.make<void>();
		yield* Stream.runForEach(
			project.SubscribeProjectSettings({ projectSlug: "myapp" }),
			(envelope) => {
				if (envelope._tag === "synchronized")
					return Deferred.succeed(subscribed, undefined);
				if (
					envelope._tag === "upsert" &&
					envelope.item._tag === "providerModels"
				)
					return Queue.offer(published, envelope.item);
				return Effect.void;
			},
		).pipe(Effect.forkScoped);
		yield* Deferred.await(subscribed);
		return { project, daemon, started, published };
	});

describe("account catalogue refresh through browser RPC", () => {
	it.effect(
		"validates and publishes a model default using the current default account",
		() =>
			Effect.gen(function* () {
				const { project, daemon, published } = yield* clients();
				yield* daemon.SetDefault({ instanceId: "personal" });
				const saved = yield* project.SetHarnessDefault({
					projectSlug: "myapp",
					harness: "claude",
					providerId: "claude",
					modelId: "personal-model",
					contextWindow: "",
				});
				expect(saved.state.status).toBe("ok");
				expect(yield* Queue.take(published)).toMatchObject({
					accountId: "personal",
					providers: [{ id: "claude", models: [{ id: "personal-model" }] }],
				});
			}).pipe(Effect.provide(daemonLayer()), Effect.timeout("10 seconds")),
	);
	it.effect(
		"discovers a changed default while the former default is still pending",
		() =>
			Effect.gen(function* () {
				const pending = yield* Deferred.make<ProviderCapabilities>();
				saveRelaySettings(
					{
						harnessDefaults: {
							claude: {
								providerId: "claude",
								modelId: "personal-model",
								contextWindow: "",
							},
						},
					},
					root,
				);
				const { project, daemon, started, published } = yield* clients(pending);
				const firstRead = yield* project
					.GetModels({ projectSlug: "myapp", instanceId: "claude" })
					.pipe(Effect.forkScoped);
				expect(yield* Queue.take(started)).toBe("claude");
				const repeatedRead = yield* project
					.GetModels({ projectSlug: "myapp", instanceId: "claude" })
					.pipe(Effect.forkScoped);
				yield* Effect.yieldNow();
				expect(yield* Queue.size(started)).toBe(0);
				yield* daemon.SetDefault({ instanceId: "personal" });
				yield* project.GetModels({ projectSlug: "myapp" });
				expect(yield* Queue.take(started)).toBe("personal");
				expect(yield* Queue.take(published)).toMatchObject({
					accountId: "personal",
					providers: [{ id: "claude", models: [{ id: "personal-model" }] }],
				});
				yield* Deferred.succeed(pending, capabilities("claude"));
				yield* Fiber.join(firstRead);
				yield* Fiber.join(repeatedRead);
				expect(yield* Queue.size(started)).toBe(0);
				expect(yield* Queue.take(published)).toMatchObject({
					accountId: "claude",
					providers: [{ id: "claude", models: [{ id: "claude-model" }] }],
				});
				const snapshot = yield* Stream.runHead(
					project.SubscribeProjectSettings({ projectSlug: "myapp" }),
				);
				expect(
					snapshot._tag === "Some" &&
						snapshot.value._tag === "snapshot" &&
						snapshot.value.rows.find((row) => row._tag === "harnessDefaults"),
				).toMatchObject({
					claude: {
						status: "ok",
						pick: { providerId: "claude", modelId: "personal-model" },
					},
				});
			}).pipe(Effect.provide(daemonLayer()), Effect.timeout("10 seconds")),
	);

	it.effect(
		"tags the catalogue published when a model-only CreateSession validates an account",
		() =>
			Effect.gen(function* () {
				const { project, daemon, published } = yield* clients();
				yield* daemon.SetDefault({ instanceId: "personal" });
				const session = yield* project.CreateSession({
					permissionMode: "ask",
					projectSlug: "myapp",
					originId: "g4zp8-catalogue-client",
					model: { providerId: "claude", modelId: "personal-model" },
				});
				expect(session.sessionId).toBeTruthy();
				expect(yield* Queue.take(published)).toMatchObject({
					accountId: "personal",
					providers: [{ id: "claude", models: [{ id: "personal-model" }] }],
				});
			}).pipe(Effect.provide(daemonLayer()), Effect.timeout("10 seconds")),
	);
});
