import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

test("settings, commands and skill documents follow a workspace change and session navigation", async ({
	page,
	harness,
}, testInfo) => {
	const main = "/workspace/main";
	const worktree = "/workspace/worktree";
	let moved = false;
	let holdMainCommands = false;
	const pendingCommands: Array<() => void> = [];
	const contexts = new Set<string>();
	const sessions: SessionInfo[] = [
		{
			accountId: "claude",
			id: "moved-session",
			title: "Moved session",
			status: "idle",
			projectSlug: "e2e-replay",
		},
		{
			accountId: "claude",
			id: "main-session",
			title: "Main session",
			status: "idle",
			projectSlug: "e2e-replay",
		},
	];
	const directoryFor = (sessionId: unknown) =>
		moved && sessionId === "moved-session" ? worktree : main;
	function recordDirectory(tag: string, sessionId: unknown) {
		const directory = directoryFor(sessionId);
		contexts.add(
			JSON.stringify({ tag, sessionId: sessionId ?? null, directory }),
		);
		return directory;
	}
	const instances = {
		instances: [
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				isDefault: true,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
			},
		],
	};
	const projects = [
		{
			slug: "e2e-replay",
			title: "Discovery project",
			folders: [main] as const,
		},
	];
	const rpc = await mockWsRpc(page, {
		stubs: {
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetModels: () => ({
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "e2e-replay",
				providers: [],
			}),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				agents: [],
				providerScope: { id: "claude", name: "Claude" },
				instanceId: "claude",
			}),
			GetCommands: async (input) => {
				const sessionId = "sessionId" in input ? input.sessionId : undefined;
				const directory = recordDirectory("GetCommands", sessionId);
				if (holdMainCommands && directory === main)
					await new Promise<void>((resolve) => pendingCommands.push(resolve));
				return {
					projectSlug: "e2e-replay",
					commands: [
						{ name: directory === worktree ? "worktree-only" : "main-only" },
					],
				};
			},
			GetSessionSkills: () => ({
				loads: [
					{
						name: "release-notes",
						invokedBy: "agent",
						turnOrdinal: 1,
						at: 1,
						anchor: { messageId: "skill-message" },
						running: false,
					},
				],
			}),
			GetSkillContent: (input) => {
				const { name } = input;
				const sessionId = "sessionId" in input ? input.sessionId : undefined;
				const directory = recordDirectory("GetSkillContent", sessionId);
				return {
					projectSlug: "e2e-replay",
					name,
					path: `${directory}/.claude/skills/${String(name)}/SKILL.md`,
					content: `Skill instructions from ${directory}`,
				};
			},
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetClaudeSettings: () => ({ projectSlug: "e2e-replay", overrides: {} }),
			ResolveClaudeSettings: (input) => {
				const sessionId = "sessionId" in input ? input.sessionId : undefined;
				const directory = recordDirectory("ResolveClaudeSettings", sessionId);
				return {
					projectSlug: "e2e-replay",
					instanceId: "claude",
					resolved: {
						attribution: {},
						autoCompactEnabled: {},
						autoCompactWindow: {},
						cleanupPeriodDays: {},
						disableAllHooks: {},
						alwaysThinkingEnabled: {
							value: directory === worktree,
							source: "project",
							path: `${directory}/.claude/settings.json`,
						},
					},
				};
			},
		},
		handlers: {
			GetInstances: () => instances,
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);

	async function openSettings(directory: string) {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
		await expect(page.getByTestId("settings-tab-general")).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await page.getByTestId("settings-tab-claude").click();
		const row = page.getByTestId("claude-setting-alwaysThinkingEnabled");
		await expect(row.getByRole("switch")).toHaveAttribute(
			"aria-checked",
			String(directory === worktree),
		);
		await expect(
			row.locator(`[title="${directory}/.claude/settings.json"]`),
		).toBeVisible();
	}
	async function openSkillDoc(directory: string) {
		await page.getByTestId("session-skills-chip").click();
		await page.getByTestId("session-skills-row").click({ button: "right" });
		await page.getByRole("menuitem", { name: "Open SKILL.md" }).click();
		await expect(page.getByTestId("session-skills-doc")).toContainText(
			`Skill instructions from ${directory}`,
		);
	}

	try {
		await page.goto(`${harness.relayBaseUrl}/s/moved-session`);
		await expect(page.getByTestId("session-bar-title")).toHaveText(
			"Moved session",
		);
		await openSettings(main);
		// A connect-time read must not overwrite a catalog fetched after the move.
		holdMainCommands = true;
		rpc.setShellRows(sessions);
		await expect.poll(() => pendingCommands.length).toBeGreaterThan(0);
		holdMainCommands = false;
		const commandReads = rpc
			.getRequests()
			.filter(({ tag }) => tag === "GetCommands").length;
		moved = true;
		sessions[0] = {
			accountId: "claude",
			id: "moved-session",
			title: "Moved session",
			status: "idle",
			projectSlug: "e2e-replay",
			workspace: {
				cause: "user",
				origin: "existing",
				worktrees: { [main]: worktree },
			},
		};
		const movedRow = sessions[0];
		rpc.setShellRows(sessions);
		const row = page.getByTestId("claude-setting-alwaysThinkingEnabled");
		await expect(row.getByRole("switch")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(
			row.locator(`[title="${worktree}/.claude/settings.json"]`),
		).toBeVisible();
		await expect
			.poll(
				() =>
					rpc.getRequests().filter(({ tag }) => tag === "GetCommands").length,
			)
			.toBeGreaterThan(commandReads);
		for (const resolve of pendingCommands.splice(0)) resolve();
		await page.getByTestId("settings-close-btn").click();
		await openSkillDoc(worktree);
		// An already-open document follows later workspace changes too.
		moved = false;
		sessions[0] = { ...movedRow, workspace: null };
		rpc.setShellRows(sessions);
		await expect(page.getByTestId("session-skills-doc")).toContainText(
			`Skill instructions from ${main}`,
		);
		moved = true;
		sessions[0] = movedRow;
		rpc.setShellRows(sessions);
		await expect(page.getByTestId("session-skills-doc")).toContainText(
			`Skill instructions from ${worktree}`,
		);
		await page.keyboard.press("Escape");
		const input = page.locator("#input");
		await input.fill("/");
		await expect(page.locator("#command-menu")).toContainText("/worktree-only");
		await expect(page.locator("#command-menu")).not.toContainText("/main-only");

		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/new/);
		await input.fill("/");
		await expect(page.locator("#command-menu")).toContainText("/main-only");
		await expect(page.locator("#command-menu")).not.toContainText(
			"/worktree-only",
		);
		await openSettings(main);
		await page.getByTestId("settings-close-btn").click();
		await rpc.waitForRequest(
			({ tag, payload }) =>
				tag === "GetCommands" && payload["sessionId"] === undefined,
		);

		await page.goto(`${harness.relayBaseUrl}/s/main-session`);
		await expect(page.getByTestId("session-bar-title")).toHaveText(
			"Main session",
		);
		await openSettings(main);
		await page.getByTestId("settings-close-btn").click();
		await openSkillDoc(main);
		await page.keyboard.press("Escape");
		await page.goto(`${harness.relayBaseUrl}/new?project=e2e-replay`);
		await openSettings(main);
		await rpc.waitForRequest(
			({ tag, payload }) =>
				tag === "ResolveClaudeSettings" && payload["sessionId"] === undefined,
		);
		for (const sessionId of ["moved-session", "main-session"]) {
			await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "ResolveClaudeSettings" && payload["sessionId"] === sessionId,
			);
			await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "GetSkillContent" && payload["sessionId"] === sessionId,
			);
		}
	} finally {
		for (const resolve of pendingCommands.splice(0)) resolve();
		// Record only stable context, sorted and deduplicated, even on failure.
		const evidence = [...contexts]
			.sort()
			.map((row) => JSON.parse(row) as unknown);
		await testInfo.attach("session-directory-contexts.json", {
			body: Buffer.from(JSON.stringify(evidence, null, 2)),
			contentType: "application/json",
		});
	}
});
