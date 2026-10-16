import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

// A draft has no session, so only the account it names can say which skills
// it has. Unnamed, the server answers with the default OpenCode catalogue.
test("a draft offers and highlights its own account's skills", async ({
	page,
	harness,
}) => {
	const instances = {
		instances: [
			{
				id: "personal",
				name: "Personal Claude",
				driver: "claude",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				isDefault: true,
			},
		],
	};
	const projects = [
		{ slug: "e2e-replay", title: "Draft project", folders: ["/workspace"] },
	];
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetInstances: () => instances,
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				agents: [],
				providerScope: { id: "claude", name: "Claude" },
				instanceId: "personal",
			}),
			GetCommands: ({ instanceId }) => ({
				projectSlug: "e2e-replay",
				commands: [
					{
						name:
							instanceId === "personal" ? "personal-skill" : "opencode-skill",
					},
				],
			}),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);

	await page.goto(`${harness.relayBaseUrl}/new?project=e2e-replay`);
	const input = page.locator("#input");
	await input.fill("Please fix that /");
	await expect(page.locator("#command-menu")).toContainText("/personal-skill");
	await expect(page.locator("#command-menu")).not.toContainText(
		"/opencode-skill",
	);

	await input.fill("Please fix that /personal-skill ");
	await expect(page.locator(".skill-pill")).toHaveText("/personal-skill");
});
