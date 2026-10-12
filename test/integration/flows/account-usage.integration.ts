// @vitest-environment jsdom
/*
 * Usage failure modes through the daemon service and browser account snapshot:
 * - API-key and auth-token accounts must never be probed or displayed.
 * - Missing configured folders must use the directory's explicit launch login.
 * - Stale readings for ineligible accounts must not reappear in either UI list.
 * - Eligible accounts without readings must remain configurable in usage order.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { expect, it } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { UsageLive } from "../../../src/lib/domain/daemon/Layers/usage-layer.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	getInstances,
	makeInstanceManagerStateLive,
	updateInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	applyUsageReadings,
	orderedSettingsUsageAccounts,
	orderedUsageAccounts,
} from "../../../src/lib/frontend/stores/usage.svelte.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";

it("filters usage by directory eligibility on the server and in both browser lists", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-account-usage-"));
	const personal = join(root, "personal");
	const folders: string[] = [];
	const launchEnvs: Array<
		Readonly<Record<string, string | undefined>> | undefined
	> = [];
	const registry = makeInstanceManagerStateLive(
		{},
		[
			{
				id: "claude",
				name: "Default",
				driver: "claude",
				port: 0,
				managed: false,
			},
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				configDir: personal,
				port: 0,
				managed: false,
			},
			{
				id: "api-key",
				name: "API key",
				driver: "claude",
				env: { ANTHROPIC_API_KEY: "fixture-key" },
				port: 0,
				managed: false,
			},
			{
				id: "auth-token",
				name: "Token",
				driver: "claude",
				env: { ANTHROPIC_AUTH_TOKEN: "fixture-token" },
				port: 0,
				managed: false,
			},
		],
		{ launchLogin: sdkDefaultClaudeConfigDir(join(root, "home", ".claude")) },
	);
	const dependencies = Layer.mergeAll(
		registry,
		makeDaemonStateLive({ configDir: root }),
		DaemonEventBusLive,
		ConfigPersistenceNoopLive,
	);
	const runtime = ManagedRuntime.make(
		UsageLive({
			cwd: root,
			shellEnv: {
				HOME: join(root, "home"),
				CLAUDE_CONFIG_DIR: join(root, "wrong-login"),
				PATH: process.env["PATH"],
			},
			queryFactory: ({ configDir, options }) => {
				folders.push(configDir.path);
				launchEnvs.push(options?.env);
				return {
					initializationResult: async () => ({}),
					usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
						async () => ({ rate_limits_available: true, rate_limits: {} }),
					close: () => {},
				};
			},
		}).pipe(Layer.provideMerge(dependencies)),
	);
	try {
		const instances = await runtime.runPromise(getInstances);
		expect(
			instances.find((instance) => instance.id === "api-key"),
		).toHaveProperty("usageEligible", false);
		expect(
			instances.find((instance) => instance.id === "auth-token"),
		).toHaveProperty("usageEligible", false);
		const readings = await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => usage.refresh()),
		);
		expect(readings.map((reading) => reading.accountId).sort()).toEqual([
			"claude",
			"personal",
		]);
		expect(folders.slice().sort()).toEqual(
			[join(root, "home", ".claude"), personal].sort(),
		);
		expect(
			launchEnvs.find((env) => env?.["CLAUDE_CONFIG_DIR"] === personal),
		).toBeDefined();
		expect(
			launchEnvs.find((env) => env?.["CLAUDE_CONFIG_DIR"] === undefined)?.[
				"HOME"
			],
		).toBe(join(root, "home"));
		applyInstanceListResponse({ instances });
		applyUsageReadings([
			...readings,
			...["api-key", "auth-token"].map((accountId) => ({
				accountId,
				harness: "claude" as const,
				status: "unknown" as const,
				windows: [],
				readAt: 0,
				stale: false,
			})),
		]);
		expect(
			orderedUsageAccounts()
				.map((reading) => reading.accountId)
				.sort(),
		).toEqual(["claude", "personal"]);
		applyUsageReadings(
			readings.filter((reading) => reading.accountId !== "personal"),
		);
		expect(
			orderedSettingsUsageAccounts()
				.map((reading) => reading.accountId)
				.sort(),
		).toEqual(["claude", "personal"]);
		await runtime.runPromise(
			updateInstance("personal", {
				env: { ANTHROPIC_API_KEY: "new-fixture-key" },
			}),
		);
		const afterEdit = await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => usage.refresh()),
		);
		expect(afterEdit.map((reading) => reading.accountId)).toEqual(["claude"]);
		await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => usage.refresh(["personal"])),
		);
		const snapshot = await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => Stream.runHead(usage.readings)),
		);
		expect(
			Option.getOrThrow(snapshot).map((reading) => reading.accountId),
		).toEqual(["claude"]);
		await runtime.runPromise(
			updateInstance("claude", {
				env: { ANTHROPIC_AUTH_TOKEN: "new-fixture-token" },
			}),
		);
		const allExcluded = await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => usage.refresh()),
		);
		expect(allExcluded).toEqual([]);
		const emptySnapshot = await runtime.runPromise(
			Effect.flatMap(Usage, (usage) => Stream.runHead(usage.readings)),
		);
		expect(Option.getOrThrow(emptySnapshot)).toEqual([]);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/g4zp-14-usage.json",
			`${JSON.stringify({ serverAccounts: readings.map((reading) => reading.accountId), afterEnvEdit: afterEdit.map((reading) => reading.accountId), afterAllExcluded: allExcluded, launchFolders: folders.map((folder) => folder.replace(root, "<fixture>")), browserAccounts: orderedSettingsUsageAccounts().map((reading) => reading.accountId) }, null, 2)}\n`,
		);
	} finally {
		await runtime.dispose();
		applyInstanceListResponse({ instances: [] });
		applyUsageReadings([]);
		rmSync(root, { recursive: true, force: true });
	}
});
