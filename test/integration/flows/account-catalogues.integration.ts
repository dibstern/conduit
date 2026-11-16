/*
 * Catalogue failure modes at the browser RPC boundary:
 * - Unknown explicit and stored account refs must fail with the ref named.
 * - A just-added account must work before daemon.json is flushed.
 * - Commands and skills must use that account's folder and session workspace.
 * - Driver catalogue keys must remain independent of account ids.
 * - The daemon must not start its saved OpenCode default without health, or let
 *   that missing health block Claude account/session model catalogues.
 * Every folder, login and config file belongs to this temporary fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { addInstance } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { applySessionCommand } from "../../../src/lib/domain/project-services/Services/session-command.js";
import { getSkillNamesForSession } from "../../../src/lib/handlers/settings.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";

describe("Integration: account catalogues", () => {
	const evidence: Array<{ name: string; result: string | undefined }> = [];
	let root: string;
	let harness: DaemonProject | undefined;
	let savedServer: MockOpenCodeServer | undefined;

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
		await savedServer?.stop();
		savedServer = undefined;
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

	it("keeps no-health OpenCode defaults off the saved server and rejects unroutable refs", async () => {
		savedServer = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await savedServer.start();
		// The daemon health-checks saved servers; this one never reports healthy.
		savedServer.setExactResponse("GET", "/global/health", 503, {
			healthy: false,
		});
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				accountDefaults: { opencode: AccountIdSchema.make("remote") },
				instances: [
					{
						id: "claude",
						name: "Claude",
						driver: "claude",
						configDir: join(root, "login"),
						port: 0,
						managed: false,
					},
					{
						id: "remote",
						name: "Saved OpenCode default",
						driver: "opencode",
						url: savedServer.url,
						port: Number(new URL(savedServer.url).port),
						managed: false,
					},
				],
			},
			root,
		);
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk,
		});
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const directory = await harness.run(AccountDirectory);
		expect(
			(await harness.run(directory.list)).find(({ id }) => id === "remote"),
		).toMatchObject({ isDefault: true });
		expect(
			await harness.run(
				directory.resolve({ _tag: "DriverDefault", driver: "opencode" }),
			),
		).toMatchObject({ id: "opencode", driver: "opencode" });
		const explicit = await client.rpcCall((rpc) =>
			rpc.GetModels({ projectSlug: "integration-test", instanceId: "claude" }),
		);
		expect(explicit.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "claude",
					models: expect.arrayContaining([
						expect.objectContaining({ id: "sonnet" }),
					]),
				}),
			]),
		);
		const created = await client.createSession(
			"Claude without OpenCode health",
			{
				instanceId: "claude",
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "",
					contextWindow: "",
				},
			},
		);
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no id");
		const active = await client.rpcCall((rpc) => rpc.GetModels({ sessionId }));
		expect(active.instanceId).toBe("claude");
		expect(active.active).toEqual({ provider: "claude", model: "sonnet" });
		expect(
			savedServer.diagnostics.filter(
				// The daemon watches every saved server (health, events, pending
				// status, permissions and questions); no default work may reach it.
				({ event, detail }) =>
					event === "request" &&
					!/^GET \/(global\/(health|event)|session\/status|permission|question)\b/.test(
						detail ?? "",
					),
			),
		).toEqual([]);
		await harness.run(
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
		// A session-scoped request names no project: its owner supplies it.
		for (const scope of [
			{ projectSlug: "integration-test", instanceId: "missing-account" },
			{ sessionId: "ses-unroutable" },
		]) {
			await expect(
				client.rpcCall((rpc) => rpc.GetModels(scope)),
			).rejects.toThrow(/missing-account/);
			await expect(
				client.rpcCall((rpc) => rpc.GetAgents(scope)),
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
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "claude",
						name: "Default",
						driver: "claude",
						configDir: login,
						port: 0,
						managed: false,
					},
				],
			},
			root,
		);
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk,
		});
		await harness.run(
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
		// A draft has no session yet; its picked account still owns the catalogue.
		const draft = await client.rpcCall((rpc) =>
			rpc.GetCommands({
				projectSlug: "integration-test",
				instanceId: "personal-account",
			}),
		);
		expect(draft.commands.map((command) => command.name)).toContain(
			"account-skill",
		);
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
		const agents = await client.rpcCall((rpc) => rpc.GetAgents({ sessionId }));
		expect(agents.providerScope.id).toBe("claude");
		expect(agents.instanceId).toBe("personal-account");
		const commands = await client.rpcCall((rpc) =>
			rpc.GetCommands({ sessionId }),
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
		const skills = await harness.run(getSkillNamesForSession(sessionId));
		expect(skills.has("account-skill")).toBe(true);
		expect(skills.has("account-command")).toBe(false);
	});
});
