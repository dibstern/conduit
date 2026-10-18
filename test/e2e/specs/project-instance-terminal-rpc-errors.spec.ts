import type { Page, TestInfo } from "@playwright/test";
import { AccountChangeRejected } from "../../../src/lib/contracts/account.js";
import {
	type InstanceListResponse,
	ProjectSaveRejected,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { initMessages } from "../fixtures/mockup-state.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure modes: structured project issues flatten into generic text; server
// reasons disappear; a failed action leaves controls disabled or closes a form.
test.use({ recording: "chat-simple" });

const instances: InstanceListResponse["instances"] = [
	{
		id: "claude",
		name: "Personal Claude",
		driver: "claude",
		isDefault: true,
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 1,
	},
	{
		id: "work",
		name: "Work Claude",
		driver: "claude",
		configDir: "/profiles/work",
		isDefault: false,
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 2,
	},
	...(["healthy", "stopped"] as const).map((status, index) => ({
		id: index === 0 ? "opencode" : "stopped",
		name: index === 0 ? "Running server" : "Stopped server",
		driver: "opencode" as const,
		port: 4096 + index,
		managed: true,
		status,
		restartCount: 0,
		createdAt: 3 + index,
	})),
];

async function openChat(page: Page, baseUrl: string, stubs: StubTable) {
	const rpc = await mockWsRpc(page, {
		stubs: {
			DetectProxy: () => ({ found: false, port: 8317 }),
			FindFolders: ({ query }) => ({
				home: "/src",
				entries: [
					{ path: query, isGitRepo: false, reason: "match", exists: true },
				],
			}),
			...stubs,
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			...initMessages.filter((message) => message.type !== "instance_list"),
			{
				type: "project_list",
				projects: [{ slug: "myapp", title: "myapp", folders: ["/src/myapp"] }],
				current: "myapp",
			},
		],
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	rpc.setDaemonList("SubscribeInstances", { instances });
	await page.goto(`${baseUrl}/s/sess-mockup-001`);
	await expect(page.locator("#input")).toBeVisible();
	await expect(page.locator(".connect-overlay")).not.toBeVisible();
	return rpc;
}

async function openServerSettings(page: Page) {
	await page.getByTestId("session-bar-title-menu").click();
	await page.getByTestId("session-title-settings").click();
	await page.getByTestId("settings-tab-server").click();
	await expect(page.getByTestId("server-settings")).toBeVisible();
}

async function attachScreen(page: Page, testInfo: TestInfo) {
	const path = testInfo.outputPath("rpc-failure.png");
	await page.screenshot({ path });
	await testInfo.attach("rpc-failure", { path, contentType: "image/png" });
}

for (const scenario of ["validation", "generic", "socket"] as const) {
	test(`project save ${scenario} failure leaves the dialog ready to retry`, async ({
		page,
		harness,
	}, testInfo) => {
		const rpc = await openChat(page, harness.relayBaseUrl, {
			SaveProject: () => {
				if (scenario === "validation")
					throw new ProjectSaveRejected({
						issues: [{ kind: "sessions-running", count: 2 }],
					});
				if (scenario === "socket") return new Promise<never>(() => {});
				throw new WsRpcError({ message: "The project is locked." });
			},
		});
		await page.getByTestId("session-scope-chip").click();
		await page.getByRole("menuitem", { name: "Add a project…" }).click();
		const dialog = page.getByRole("dialog", {
			name: "Add project",
			exact: true,
		});
		await dialog.getByRole("combobox", { name: "Add folder" }).fill("/src/new");
		await dialog.getByRole("option", { name: "/src/new", exact: true }).click();
		const save = dialog.getByRole("button", { name: /^Add project/ });
		await save.click();
		await rpc.waitForRequest(({ tag }) => tag === "SaveProject");
		if (scenario === "socket") rpc.closeSockets();
		await expect(dialog).toContainText(
			scenario === "validation"
				? "2 sessions are running. Save when they finish."
				: scenario === "generic"
					? "The project is locked."
					: "Couldn't save the project. Try again.",
		);
		await expect(dialog).toBeVisible();
		await expect(save).toBeEnabled();
		await attachScreen(page, testInfo);
	});
}

for (const action of ["default", "edit", "add", "remove"] as const) {
	test(`account ${action} refusal shows the action and declared reason`, async ({
		page,
		harness,
	}, testInfo) => {
		const refuse = () => {
			throw new AccountChangeRejected({
				id: "work",
				reason: "This account is in use by a running session.",
			});
		};
		const rpc = await openChat(page, harness.relayBaseUrl, {
			SetDefault: refuse,
			UpdateInstance: refuse,
			AddInstance: refuse,
			RemoveInstance: refuse,
		});
		await openServerSettings(page);
		const row = page.getByTestId("instance-row-work");
		if (action === "add") {
			await page.getByTestId("add-instance-btn").click();
			await page.getByTestId("instance-form-name").fill("Team Claude");
			await page.getByTestId("instance-form-save").click();
		} else {
			await row.getByRole("button", { expanded: false }).click();
			if (action === "default")
				await row.getByTestId("make-default-btn").click();
			else if (action === "edit") {
				await row.getByTestId("edit-instance-btn").click();
				await page.getByTestId("instance-form-name").fill("Team Claude");
				await page.getByTestId("instance-form-save").click();
			} else {
				await row.getByTestId("remove-instance-btn").click();
				await page
					.locator("#confirm-modal")
					.getByRole("button", { name: "Confirm", exact: true })
					.click();
			}
		}
		const tags = {
			default: "SetDefault",
			edit: "UpdateInstance",
			add: "AddInstance",
			remove: "RemoveInstance",
		};
		await rpc.waitForRequest(({ tag }) => tag === tags[action]);
		const toast = page.getByTestId("toast");
		await expect(toast).toContainText(
			action === "default"
				? "Failed to change default account"
				: `Failed to ${action === "edit" ? "update" : action} instance`,
		);
		await expect(toast).toContainText(
			"This account is in use by a running session.",
		);
		await expect(row).toContainText("Work Claude");
		if (action === "add" || action === "edit") {
			await expect(page.getByTestId("instance-form-name")).toHaveValue(
				"Team Claude",
			);
			await expect(page.getByTestId("instance-form-save")).toBeEnabled();
		} else if (action === "default")
			await expect(row.getByTestId("make-default-btn")).toBeEnabled();
		await attachScreen(page, testInfo);
	});
}

for (const action of ["start", "stop", "scan"] as const) {
	test(`instance ${action} failure shows the server reason`, async ({
		page,
		harness,
	}, testInfo) => {
		const refuse = () => {
			throw new WsRpcError({ message: "The provider is unavailable." });
		};
		const rpc = await openChat(page, harness.relayBaseUrl, {
			StartInstance: refuse,
			StopInstance: refuse,
			ScanNow: refuse,
		});
		await openServerSettings(page);
		if (action === "scan") await page.getByTestId("scan-now-btn").click();
		else {
			const row = page.getByTestId(
				`instance-row-${action === "start" ? "stopped" : "opencode"}`,
			);
			await row.getByRole("button", { expanded: false }).click();
			await row
				.getByRole("button", {
					name: action === "start" ? "Start" : "Stop",
					exact: true,
				})
				.click();
		}
		await rpc.waitForRequest(
			({ tag }) =>
				tag ===
				(action === "scan"
					? "ScanNow"
					: action === "start"
						? "StartInstance"
						: "StopInstance"),
		);
		const toast = page.getByTestId("toast");
		await expect(toast).toContainText(
			action === "scan" ? "Port scan failed" : `Failed to ${action} instance`,
		);
		await expect(toast).toContainText("The provider is unavailable.");
		if (action === "scan")
			await expect(page.getByTestId("scan-now-btn")).toBeEnabled();
		await attachScreen(page, testInfo);
	});
}

test("terminal creation failure shows the server reason and permits retry", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openChat(page, harness.relayBaseUrl, {
		CreatePty: () => {
			throw new WsRpcError({ message: "The terminal host is unavailable." });
		},
	});
	await page.getByTestId("views-rail-terminal").click();
	await rpc.waitForRequest(({ tag }) => tag === "CreatePty");
	await expect(page.locator("#terminal-panel .term-status")).toHaveText(
		"The terminal host is unavailable.",
	);
	await expect(page.locator("#terminal-panel")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "+ Terminal", exact: true }),
	).toBeEnabled();
	await attachScreen(page, testInfo);
});
