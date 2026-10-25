// Launch failures: a Side Thread loses its fence on a cold/warm launch, adopts
// an unfenced warm query, inherits full access, nests, or fences a plain Fork.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { forkSession } from "../../../src/lib/domain/relay/Services/session-command.js";
import {
	getPermissionMode,
	setDefaultPermissionMode,
	setModel,
	setPermissionMode,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import type { Options, Query } from "../../../src/lib/provider/claude/types.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const worktreeLine =
	"To work in another worktree, use EnterWorktree instead of cd.";
const sideThreadLine =
	"This is a Side Thread: answer the user's side question about the conversation so far. Do not continue the parent session's task or goal.";

describe("Integration: Claude Side Thread launch fence", () => {
	let root: string;
	let harness: RelayHarness | undefined;
	let launches: Array<{ options: Options; query: Query }>;
	const evidence: unknown[] = [];

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "conduit-side-thread-launch-"));
		for (const folder of ["home", "login"]) mkdirSync(join(root, folder));
		writeFileSync(join(root, "login", "conduit-test-record-forks"), "");
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "login"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", root);
		// Use the fixture environment without the developer's login shell or mise.
		vi.spyOn(ProjectShellEnvResolver.prototype, "register").mockImplementation(
			() => {},
		);
		vi.spyOn(
			ProjectShellEnvResolver.prototype,
			"waitUntilReady",
		).mockResolvedValue(true);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
		launches = [];
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "claude",
						name: "Claude",
						driver: "claude",
						configDir: join(root, "login"),
						port: 0,
						managed: false,
					},
				],
			},
			root,
		);
	});

	afterEach(async ({ task }) => {
		try {
			await harness?.stop();
		} finally {
			harness = undefined;
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			__setProbeOverrideForTesting(undefined);
			evidence.push({
				name: task.name,
				result: task.result?.state,
				launches: launches.map(({ options }) => ({
					resume: options.resume,
					systemPrompt: options.systemPrompt,
					disallowedTools: options.disallowedTools,
					permissionMode: options.permissionMode,
				})),
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/hiuf-5-side-thread-launch.json",
				`${JSON.stringify({ cases: evidence }, null, 2)}\n`,
			);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		"cold",
		"pre-warmed",
		"unfenced pre-warm",
		"pre-warmed with changed permissions",
	] as const)("%s launch fences a Side Thread and leaves a plain Fork alone", async (launch) => {
		const changedPermissions = launch === "pre-warmed with changed permissions";
		const sdkPermissionMode = changedPermissions
			? "bypassPermissions"
			: "default";
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					if (!params.options) throw new Error("Missing SDK launch options");
					const query = claudeSdk.query(params);
					vi.spyOn(query, "close");
					launches.push({ options: params.options, query });
					return query;
				},
			},
		});
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const parent = await client.createSession("Parent task", {
			instanceId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "",
			},
		});
		const parentId = parent["id"];
		if (typeof parentId !== "string") throw new Error("Missing parent id");
		await runtime.runPromise(setDefaultPermissionMode("full"));
		await runtime.runPromise(setPermissionMode(parentId, "full"));
		const parentEnd = client.waitForTurnEnd(parentId);
		await client.sendMessage("Reply with pong", { sessionId: parentId });
		expect((await parentEnd).attention).not.toBe("error");
		const parentLaunch = launches.at(-1)?.options;
		expect(parentLaunch?.systemPrompt).toBe(worktreeLine);
		expect(parentLaunch?.disallowedTools).toBeUndefined();
		expect(parentLaunch?.permissionMode).toBe("bypassPermissions");

		const inputId = randomUUID();
		let warmed: (typeof launches)[number] | undefined;
		let reservedId: string | undefined;
		if (launch !== "cold") {
			// StartSideThread admits immediately. Create through its same command,
			// then retry that input id over RPC after warming the idle Side Thread.
			const side = await runtime.runPromise(
				forkSession(parentId, { side: { title: "Side question", inputId } }),
			);
			reservedId = side.id;
			expect(await runtime.runPromise(getPermissionMode(side.id))).toBe("ask");
			if (changedPermissions)
				await runtime.runPromise(setPermissionMode(side.id, "full"));
			// This reserved session has not reached send dispatch's transient binding.
			harness.stack.orchestration.engine.bindSession(side.id, "claude");
			await runtime.runPromise(
				setModel(side.id, { providerID: "claude", modelID: "sonnet" }),
			);
			if (launch === "unfenced pre-warm") {
				const instance =
					harness.stack.orchestration.registry.getInstance("claude");
				if (!instance?.preWarmSessionEffect)
					throw new Error("Claude pre-warm is unavailable");
				const preWarm = instance.preWarmSessionEffect.bind(instance);
				// Simulate a warm launch made before the Side Thread flag arrived.
				vi.spyOn(instance, "preWarmSessionEffect").mockImplementationOnce(
					(input) => preWarm({ ...input, sideThread: false }),
				);
			}
			await client.rpcCall((rpc) => rpc.PreWarmSession({ sessionId: side.id }));
			warmed = launches.at(-1);
			expect(warmed?.options).toMatchObject({
				resume: expect.any(String),
				forkSession: true,
				sessionId: side.id,
			});
			expect(warmed?.options.resume).not.toBe(side.id);
			expect(warmed?.options.permissionMode).toBe(sdkPermissionMode);
			if (launch !== "unfenced pre-warm") {
				expect(warmed?.options.systemPrompt).toBe(
					`${worktreeLine}\n${sideThreadLine}`,
				);
				expect(warmed?.options.disallowedTools).toContain("SendMessage");
			} else {
				expect(warmed?.options.systemPrompt).toBe(worktreeLine);
				expect(warmed?.options.disallowedTools).toBeUndefined();
			}
		}
		const beforeSend = launches.length;
		const side = await client.rpcCall((rpc) =>
			rpc.StartSideThread({
				sessionId: parentId,
				title: "Side question",
				inputId,
				text: "What does the conversation so far mean?",
				originId: client.getClientId(),
			}),
		);
		if (reservedId) expect(side.sessionId).toBe(reservedId);
		await client.viewSession(side.sessionId);
		expect((await client.waitForTurnEnd(side.sessionId)).attention).not.toBe(
			"error",
		);
		expect(await runtime.runPromise(getPermissionMode(side.sessionId))).toBe(
			changedPermissions ? "full" : "ask",
		);
		const sideLaunch = launches.at(-1)?.options;
		if (launch === "unfenced pre-warm") {
			expect(sideLaunch?.resume).toBe(side.sessionId);
			expect(sideLaunch?.forkSession).toBeUndefined();
		} else {
			expect(sideLaunch).toMatchObject({
				resume: expect.any(String),
				forkSession: true,
				sessionId: side.sessionId,
			});
			expect(sideLaunch?.resume).not.toBe(side.sessionId);
		}
		expect(sideLaunch?.systemPrompt).toBe(`${worktreeLine}\n${sideThreadLine}`);
		expect(sideLaunch?.disallowedTools).toContain("SendMessage");
		expect(sideLaunch?.permissionMode).toBe(sdkPermissionMode);
		expect(launches).toHaveLength(
			beforeSend +
				(launch === "cold" || launch === "unfenced pre-warm" ? 1 : 0),
		);
		if (launch === "unfenced pre-warm")
			expect(warmed?.query.close).toHaveBeenCalled();
		await expect(
			client.rpcCall((rpc) =>
				rpc.StartSideThread({
					sessionId: side.sessionId,
					title: "Nested question",
					inputId: randomUUID(),
					text: "Another side question",
				}),
			),
		).rejects.toThrow("Cannot start a Side Thread from a Side Thread");

		const fork = await client.forkSession({ sessionId: parentId });
		const forkId = fork["id"];
		if (typeof forkId !== "string") throw new Error("Missing Fork id");
		const forkEnd = client.waitForTurnEnd(forkId);
		await client.sendMessage("Continue the task", { sessionId: forkId });
		expect((await forkEnd).attention).not.toBe("error");
		const forkLaunch = launches.at(-1)?.options;
		expect(forkLaunch).toMatchObject({
			resume: expect.any(String),
			forkSession: true,
			sessionId: forkId,
		});
		expect(forkLaunch?.resume).not.toBe(forkId);
		expect(forkLaunch?.systemPrompt).toBe(worktreeLine);
		expect(forkLaunch?.disallowedTools).toBeUndefined();
		expect(forkLaunch?.permissionMode).toBe("bypassPermissions");
	});
});
