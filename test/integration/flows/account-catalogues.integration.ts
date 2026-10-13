/*
 * Catalogue failure modes at the browser RPC and relay boundary:
 * - Unknown explicit and stored account refs must fail with the ref named.
 * - A just-added account must work before daemon.json is flushed.
 * - Commands and skills must use that account's folder and session workspace.
 * - Driver catalogue keys must remain independent of account ids.
 * Every folder, login and config file belongs to this temporary fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	type DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addInstance,
	makeInstanceManagerStateLive,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { getSkillNamesForSession } from "../../../src/lib/handlers/settings.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: account catalogues", () => {
	const evidence: Array<{ name: string; result: string | undefined }> = [];
	let root: string;
	let harness: RelayHarness | undefined;
	let disposeRegistry: (() => Promise<void>) | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-account-catalogues-"));
		for (const folder of ["home", "login"]) mkdirSync(join(root, folder));
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "login"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", root);
		// The separate capability-probe ticket owns SDK catalogue account scoping.
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async ({ task }) => {
		await harness?.stop();
		harness = undefined;
		await disposeRegistry?.();
		disposeRegistry = undefined;
		vi.unstubAllEnvs();
		__setProbeOverrideForTesting(undefined);
		evidence.push({ name: task.name, result: task.result?.state });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/g4zp-14-catalogues.json",
			`${JSON.stringify({ cases: evidence }, null, 2)}\n`,
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects unroutable explicit and session refs without querying OpenCode", async () => {
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk,
		});
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await harness.stack.effectRuntime.runtime.runPromise(
			applySessionCommand({
				type: "session.created",
				data: {
					sessionId: "ses-unroutable",
					title: "Unknown",
					provider: "missing-account",
				},
			}),
		);
		const before = harness.mock.diagnostics.length;
		for (const scope of [
			{ instanceId: "missing-account" },
			{ sessionId: "ses-unroutable" },
		]) {
			await expect(
				client.rpcCall((rpc) =>
					rpc.GetModels({ projectSlug: "integration-test", ...scope }),
				),
			).rejects.toThrow(/missing-account/);
			await expect(
				client.rpcCall((rpc) =>
					rpc.GetAgents({ projectSlug: "integration-test", ...scope }),
				),
			).rejects.toThrow(/missing-account/);
		}
		expect(
			harness.mock.diagnostics
				.slice(before)
				.filter(
					(entry) =>
						entry.event === "request" &&
						/provider|agent/.test(entry.detail ?? ""),
				),
		).toEqual([]);
	});

	it("discovers a live non-default account's commands and skills before config flush", async () => {
		const login = join(root, "login");
		const accountFolder = join(root, "account-login");
		mkdirSync(join(accountFolder, "commands"), { recursive: true });
		mkdirSync(join(accountFolder, "skills", "account-skill"), {
			recursive: true,
		});
		mkdirSync(join(login, "commands"));
		writeFileSync(
			join(accountFolder, "commands", "account-command.md"),
			"---\ndescription: Account command\n---\nRun it\n",
		);
		writeFileSync(
			join(accountFolder, "skills", "account-skill", "SKILL.md"),
			"---\nname: account-skill\ndescription: Account skill\n---\nUse it\n",
		);
		writeFileSync(
			join(login, "commands", "default-only.md"),
			"Default command\n",
		);
		const registry = makeInstanceManagerStateLive(
			{},
			[
				{
					id: "claude",
					name: "Default",
					driver: "claude",
					configDir: login,
					port: 0,
					managed: false,
				},
			],
			{ launchLogin: configuredClaudeConfigDir(login) },
		);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				registry,
				DaemonEventBusLive,
				DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
				Layer.succeed(ConfigPersistenceTag, {
					requestSave: Effect.void,
					flush: Effect.fail(new Error("Fixture never flushes config")),
				}),
			),
		);
		disposeRegistry = () => runtime.dispose();
		const daemonConfigContext = await runtime.runPromise(
			Effect.context<
				AccountDirectory | DaemonConfigRefTag | ConfigPersistenceTag
			>(),
		);
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			daemonConfigContext,
			defaultModel: null,
			claudeSdk,
		});
		await runtime.runPromise(
			addInstance({
				id: "personal-account",
				name: "Personal",
				driver: "claude",
				configDir: accountFolder,
				managed: false,
			}),
		);
		const client = await harness.connectWsClient();
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
		const created = await client.createSession("Personal commands", {
			instanceId: "personal-account",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "",
			},
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no id");
		const agents = await client.rpcCall((rpc) =>
			rpc.GetAgents({ projectSlug: "integration-test", sessionId }),
		);
		expect(agents.providerScope.id).toBe("claude");
		expect(agents.instanceId).toBe("personal-account");
		const commands = await client.rpcCall((rpc) =>
			rpc.GetCommands({ projectSlug: "integration-test", sessionId }),
		);
		expect(commands.commands.map((command) => command.name)).toContain(
			"account-command",
		);
		expect(commands.commands.map((command) => command.name)).toContain(
			"account-skill",
		);
		expect(commands.commands.map((command) => command.name)).not.toContain(
			"default-only",
		);
		const skills = await harness.stack.effectRuntime.runtime.runPromise(
			getSkillNamesForSession(sessionId),
		);
		expect(skills.has("account-skill")).toBe(true);
		expect(skills.has("account-command")).toBe(false);
	});
});
