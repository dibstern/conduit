/*
 * Public preview/continuation failure modes:
 * - A deleted binding rejects the effective account shown by the composer.
 * - Accepting effective IDs breaks callers holding the original binding token.
 * - Changing the default after preview permits a stale live expected account.
 * - Changing the default during quota probing retargets a captured source,
 *   especially when the caller still holds a deleted binding token.
 * - A historical recovery token silently prevents scheduling via an effective ID.
 * Refusals must append no events and dispatch no turn. Successful switches
 * must publish Work as the binding and send with Work's own folder.
 * All account folders, HOME, CLAUDE_CONFIG_DIR and configDir are fixture-owned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Either, Stream } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import {
	makeContinuation,
	previewContinuation,
} from "../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";
import { usageReading } from "../../helpers/usage.js";

let root: string;
const evidence: {
	tests: Array<{ name: string; result: string | undefined }>;
	observations: Array<{
		name: string;
		expectedAccount: string;
		outcome: string;
		binding: string | undefined;
		sends: Array<{ accountId: string; folder: string; sessionId: string }>;
	}>;
} = { tests: [], observations: [] };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-effective-continuation-"));
	for (const folder of [
		"config",
		"home",
		"launch",
		"project",
		"personal",
		"work",
		"spare",
	])
		mkdirSync(join(root, folder));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", join(root, "config"));
});

afterEach(({ task }) => {
	vi.unstubAllEnvs();
	evidence.tests.push({ name: task.name, result: task.result?.state });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/g4zp9-effective-continuation.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	rmSync(root, { recursive: true, force: true });
});

for (const scenario of [
	{
		name: "switches a deleted binding from Personal to Work using the published effective account",
		expectedAccount: "personal",
		changeDefault: "never",
		outcome: "Right",
	},
	{
		name: "preserves callers using the original deleted binding token",
		expectedAccount: "deleted-claude",
		changeDefault: "never",
		outcome: "Right",
	},
	{
		name: "schedules a deleted binding through its published effective account",
		expectedAccount: "personal",
		changeDefault: "never",
		at: 2000,
		outcome: "Right",
	},
	{
		name: "rejects a stale effective account when the default changes after preview",
		expectedAccount: "personal",
		changeDefault: "after-preview",
		outcome: "StaleSwitch",
	},
	{
		name: "rejects an effective source changed during quota probing",
		expectedAccount: "personal",
		changeDefault: "during-quota",
		outcome: "StaleSwitch",
	},
	{
		name: "rejects a changed source during quota even with the original binding token",
		expectedAccount: "deleted-claude",
		changeDefault: "during-quota",
		outcome: "StaleSwitch",
	},
] as const) {
	it.scoped(scenario.name, () => {
		const targetAccount = "at" in scenario ? "personal" : "work";
		const sends: Array<{
			accountId: string;
			folder: string;
			sessionId: string;
		}> = [];
		const registry = new ProviderRegistry([
			{
				providerId: "claude",
				steering: true,
				discoverEffect: () =>
					Effect.die("Continuation must not discover providers"),
				sendTurnEffect: () =>
					Effect.die("Turn delivery is supplied by the fixture"),
				preWarmSessionEffect: () => Effect.void,
				interruptTurnEffect: () => Effect.void,
				resolvePermissionEffect: () => Effect.void,
				resolveQuestionEffect: () => Effect.void,
				endSessionEffect: () => Effect.void,
				shutdownEffect: () => Effect.void,
			},
		]);
		const engine = new OrchestrationEngine({ registry });
		const database = join(root, "config", "events.db");
		const accounts = accountsStateFromInstances(
			["personal", "work", "spare"].map((id) => ({
				id,
				name: id.charAt(0).toUpperCase() + id.slice(1),
				driver: "claude" as const,
				configDir: join(root, id),
			})),
			configuredClaudeConfigDir(join(root, "launch")),
			5,
			{
				defaultClaudeId: "personal",
				deleted: [
					{ id: AccountIdSchema.make("deleted-claude"), driver: "claude" },
				],
			},
		);
		return Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const store = yield* EventStoreEffectTag;
			const commit = yield* makeCommitAndSignal;
			const read = yield* ReadQueryEffectTag;
			const continuation = yield* makeContinuation;
			yield* commit([
				canonicalEvent("session.created", "s1", {
					sessionId: "s1",
					title: "Deleted account conversation",
					provider: "deleted-claude",
				}),
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u1",
					role: "user",
				}),
				canonicalEvent("session.usage_limited", "s1", {
					instanceId: "deleted-claude",
					rateLimitType: "seven_day",
					cutOffMessageId: "u1",
				}),
			]);
			engine.bindSession("s1", "deleted-claude");
			yield* previewContinuation("s1", targetAccount);
			if (scenario.changeDefault === "after-preview")
				yield* directory.apply({ _tag: "SetDefault", id: "spare" });
			const before = yield* store.readAllBySession("s1");
			const result = yield* continuation
				.requestContinuation("s1", {
					instanceId: targetAccount,
					expectedInstanceId: scenario.expectedAccount,
					reason: "user",
					...("at" in scenario ? { at: scenario.at } : {}),
				})
				.pipe(
					Effect.provideService(Usage, {
						readings: Stream.empty,
						latest: () => Effect.succeed(undefined),
						turnEnded: () => Effect.void,
						refresh: () =>
							Effect.gen(function* () {
								if (scenario.changeDefault === "during-quota")
									yield* directory.apply({ _tag: "SetDefault", id: "spare" });
								return [usageReading(targetAccount)];
							}).pipe(Effect.orDie),
						pickFailover: () => Effect.succeed(undefined),
					}),
					Effect.either,
				);
			const binding = (yield* read.getSession("s1"))?.provider;
			const outcome = Either.isRight(result) ? "Right" : result.left._tag;
			evidence.observations.push({
				name: scenario.name,
				expectedAccount: scenario.expectedAccount,
				outcome,
				binding,
				sends,
			});
			expect(outcome).toBe(scenario.outcome);
			if ("at" in scenario) {
				expect(binding).toBe("deleted-claude");
				expect(sends).toEqual([]);
				expect(
					(yield* read.listSessionInfos())[0]?.limitRecovery,
				).toMatchObject({
					instanceId: "deleted-claude",
					scheduledAt: scenario.at,
				});
				expect(
					(yield* store.readAllBySession("s1")).filter(
						(event) => event.type === "session.resume_scheduled",
					),
				).toHaveLength(1);
			} else if (Either.isRight(result)) {
				expect(binding).toBe("work");
				expect(yield* engine.getProviderForSessionEffect("s1")).toBe("work");
				expect(sends).toEqual([
					{ accountId: "work", folder: join(root, "work"), sessionId: "s1" },
				]);
				expect(
					(yield* store.readAllBySession("s1")).filter(
						(event) => event.type === "session.resumed",
					),
				).toHaveLength(1);
			} else {
				expect(binding).toBe("deleted-claude");
				expect(sends).toEqual([]);
				expect(yield* store.readAllBySession("s1")).toEqual(before);
			}
		}).pipe(
			Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Effect.provideService(LoggerTag, makeMockLogger()),
			Effect.provideService(OrchestrationEngineTag, engine),
			Effect.provideService(ProviderRegistryTag, registry),
			Effect.provideService(AgentServiceTag, {
				getActiveAgent: () => Effect.succeed(undefined),
				listAgents: () => Effect.die("Continuation must not discover agents"),
				switchAgent: () => Effect.die("Continuation must not change agents"),
			}),
			Effect.provide(AlertsLive),
			Effect.provideService(ConfigTag, {
				httpServer: createServer(),
				projectDir: join(root, "project"),
				slug: "effective-continuation",
				configDir: join(root, "config"),
				persistenceDbPath: database,
				publishGlobalSetting: () => Effect.void,
			}),
			Effect.provideService(ProviderTurnServiceTag, {
				holdUserTurnsForAccountSwitch: () => Effect.void,
				prepareTurnSession: (input) => Effect.succeed(input.sessionId),
				interruptTurn: () => Effect.void,
				sendTurn: (input) =>
					Effect.sync(() => {
						const account = input.account;
						if (account?.driver === "claude")
							sends.push({
								accountId: account.id,
								folder: account.folder.path,
								sessionId: input.sessionId,
							});
					}),
			}),
			Effect.provide(AccountDirectoryStateLive(accounts)),
			Effect.provide(makeOverridesStateLive()),
			Effect.provide(
				makePersistenceEffectLayer(database, "effective-continuation"),
			),
		);
	});
}
