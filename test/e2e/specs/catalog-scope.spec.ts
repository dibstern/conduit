import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { Effect, Stream } from "effect";
import type { GetModelsResponse } from "../../../src/lib/contracts/ws-rpc.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

const alphaSession = "catalog-alpha";
const secondSession = "catalog-second";
const projects = [
	{ slug: "e2e-replay", title: "Alpha project", folders: ["/workspace/alpha"] },
	{ slug: "beta", title: "Beta project", folders: ["/workspace/beta"] },
];
const sessions = [
	{
		id: alphaSession,
		title: "Alpha session",
		status: "idle" as const,
		projectSlug: "e2e-replay",
		accountId: "opencode",
		updatedAt: 200,
	},
	{
		id: secondSession,
		title: "Second session",
		status: "idle" as const,
		projectSlug: "e2e-replay",
		accountId: "opencode",
		updatedAt: 100,
	},
];

async function setup(page: Page) {
	const pending = new Map<string, Promise<void>>();
	const catalogName = (scope: string) =>
		scope === secondSession ? "Second" : scope === "beta" ? "Beta" : "Alpha";
	const projectFor = (scope: string) =>
		scope === "beta" ? "beta" : "e2e-replay";
	const reply = <T>(scope: string, value: T): T | Promise<T> =>
		pending.get(scope)?.then(() => value) ?? value;
	const modelsFor = (scope: string): GetModelsResponse => {
		const name = catalogName(scope);
		return {
			projectSlug: projectFor(scope),
			instanceId: "opencode",
			defaultOpenCodeInstanceId: "opencode",
			providers: [
				{
					id: "opencode",
					name: "OpenCode",
					configured: true,
					models: [
						{
							id: `${name.toLowerCase()}-model`,
							name: `${name} model`,
							provider: "opencode",
						},
					],
				},
			],
			active: { provider: "opencode", model: `${name.toLowerCase()}-model` },
		};
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetModels: (params) => {
				const scope =
					"sessionId" in params ? params.sessionId : params.projectSlug;
				return reply(scope, modelsFor(scope));
			},
			SubscribeDraftModels: ({ projectSlug, instanceId }) =>
				Stream.fromEffect(
					Effect.promise(() =>
						Promise.resolve(
							reply(projectSlug, { ...modelsFor(projectSlug), instanceId }),
						),
					),
				).pipe(Stream.concat(Stream.never)),
			GetAgents: (params) => {
				const scope =
					"sessionId" in params ? params.sessionId : params.projectSlug;
				const name = catalogName(scope);
				return reply(scope, {
					projectSlug: projectFor(scope),
					instanceId: "opencode",
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [
						{ id: `${name.toLowerCase()}-agent`, name: `${name} agent` },
						{
							id: `${name.toLowerCase()}-review-agent`,
							name: `${name} review agent`,
						},
					],
				});
			},
			GetCommands: (params) => {
				const scope =
					"sessionId" in params ? params.sessionId : params.projectSlug;
				return reply(scope, {
					projectSlug: projectFor(scope),
					commands: [{ name: `${catalogName(scope).toLowerCase()}-command` }],
				});
			},
			ResolveSession: () => ({ projectSlug: "e2e-replay" }),
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			AttachProject: (payload) => ({
				projectSlug:
					("projectSlug" in payload && payload.projectSlug) || "e2e-replay",
				sessionSlug: "sessionId" in payload ? "e2e-replay" : null,
			}),
		},
		streams: {
			SubscribeInputDraft: ({ key }) => [
				{
					_tag: "synchronized",
					...((key as { session?: string }).session && {
						text: `Prompt for ${(key as { session?: string }).session}`,
					}),
				},
			],
			SubscribeProjectSettings: (params) => {
				const modelId = `${catalogName(String(params["projectSlug"])).toLowerCase()}-model`;
				return [
					{
						_tag: "snapshot",
						sequence: 1,
						rows: [
							{
								_tag: "harnessDefaults",
								opencode: {
									status: "ok",
									pick: {
										providerId: "opencode",
										modelId,
										effort: "",
										contextWindow: "",
									},
								},
							},
							{
								_tag: "defaultModel",
								provider: "opencode",
								model: modelId,
								variant: "",
							},
						],
					},
					{ _tag: "synchronized" },
				];
			},
			SubscribeShell: () => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: sessions,
				},
				{ _tag: "synchronized" },
			],
		},
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				isDefault: true,
			},
		],
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	return {
		rpc,
		hold(scope: string) {
			let release = () => {};
			pending.set(
				scope,
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			);
			return () => {
				pending.delete(scope);
				release();
			};
		},
	};
}

async function openModels(page: Page) {
	if (await page.getByTestId("model-picker").isVisible()) {
		const back = page.getByTestId("picker-back");
		if (await back.isVisible()) await back.click();
	} else {
		await openPickerRoot(page, page.getByTestId("model-picker-trigger"));
	}
	await page.getByTestId("picker-row-model").click();
	return page.getByTestId("model-picker-list");
}

async function closePicker(page: Page) {
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path });
	await testInfo.attach(name, {
		path,
		contentType: "image/png",
	});
}

test("switching draft projects never displays an old project's in-flight catalogs", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc, hold } = await setup(page);
	const releaseAlpha = hold("e2e-replay");
	const releaseBeta = hold("beta");
	const deliveredAlpha = new Set<string>();
	await page.exposeFunction("catalogReplyDelivered", (frame: string) => {
		for (const catalog of ["alpha-model", "alpha-agent", "alpha-command"]) {
			if (
				frame.includes(catalog) &&
				(catalog !== "alpha-model" || frame.includes('"providers"'))
			) {
				deliveredAlpha.add(catalog);
			}
		}
	});
	await page.addInitScript(() => {
		const OriginalWebSocket = window.WebSocket;
		window.WebSocket = class extends OriginalWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
					if (typeof data !== "string") return;
					void (
						window as Window & {
							catalogReplyDelivered?: (frame: string) => Promise<void>;
						}
					).catalogReplyDelivered?.(data);
				});
			}
		};
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=e2e-replay`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetCommands" &&
			request.payload["projectSlug"] === "e2e-replay",
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetAgents" &&
			request.payload["projectSlug"] === "e2e-replay",
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetModels" &&
			request.payload["projectSlug"] === "e2e-replay",
	);
	await page.getByTestId("draft-project-chip").click();
	await page
		.getByRole("menuitemradio", { name: "Beta project", exact: true })
		.click();
	await expect(page).toHaveURL(/project=beta/);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetCommands" &&
			request.payload["projectSlug"] === "beta",
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetAgents" && request.payload["projectSlug"] === "beta",
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetModels" && request.payload["projectSlug"] === "beta",
	);
	releaseBeta();
	await expect(await openModels(page)).toContainText("Beta model");
	await closePicker(page);
	await openPickerRoot(page, page.getByTestId("model-picker-trigger"));
	await page.getByTestId("picker-row-agent").click();
	await expect(page.getByTestId("picker-agent-beta-agent")).toContainText(
		"Beta agent",
	);
	await closePicker(page);
	await page.locator("#input").fill("/");
	await expect(page.locator("#command-menu")).toContainText("/beta-command");
	releaseAlpha();
	await expect
		.poll(() => [...deliveredAlpha].sort())
		.toEqual(["alpha-agent", "alpha-command", "alpha-model"]);
	await testInfo.attach("old-project-replies-delivered", {
		body: JSON.stringify([...deliveredAlpha].sort()),
		contentType: "application/json",
	});
	await expect(page.locator("#command-menu")).toContainText("/beta-command");
	await expect(page.locator("#command-menu")).not.toContainText(
		"/alpha-command",
	);
	await page.locator("#input").fill("");
	await expect(await openModels(page)).toContainText("Beta model");
	await expect(page.getByTestId("model-picker-list")).not.toContainText(
		"Alpha model",
	);
	await closePicker(page);
	await openPickerRoot(page, page.getByTestId("model-picker-trigger"));
	await page.getByTestId("picker-row-agent").click();
	await expect(page.getByTestId("picker-agent-beta-agent")).toContainText(
		"Beta agent",
	);
	await expect(
		page.getByTestId("picker-agent-beta-review-agent"),
	).toContainText("Beta review agent");
	await expect(page.getByTestId("model-picker")).not.toContainText(
		"Alpha agent",
	);
	await capture(page, testInfo, "beta-draft-catalogs");
});

test("fast session switches keep the model list matched to the displayed session", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc, hold } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${alphaSession}`);
	await expect(page.locator("#input")).toHaveValue(
		`Prompt for ${alphaSession}`,
	);
	await expect(await openModels(page)).toContainText("Alpha model");
	await closePicker(page);
	await new SidebarPage(page).clickSession(secondSession);
	await expect(await openModels(page)).toContainText("Second model");
	await closePicker(page);
	await new SidebarPage(page).clickSession(alphaSession);
	await expect(await openModels(page)).toContainText("Alpha model");
	await closePicker(page);
	const secondReadCount = () =>
		rpc
			.getRequests()
			.filter(
				(request) =>
					request.tag === "GetModels" &&
					request.payload["sessionId"] === secondSession,
			).length;
	const previousSecondReads = secondReadCount();
	const releaseSecond = hold(secondSession);
	await new SidebarPage(page).clickSession(secondSession);
	await expect.poll(secondReadCount).toBeGreaterThan(previousSecondReads);
	await expect(page.locator("#input")).toHaveValue(
		`Prompt for ${secondSession}`,
	);
	const trigger = page.getByTestId("model-picker-trigger");
	if ((await trigger.isVisible()) && (await trigger.isEnabled())) {
		const secondModels = await openModels(page);
		await capture(page, testInfo, "second-session-catalog-pending");
		await expect.soft(secondModels).not.toContainText("Alpha model");
		await closePicker(page);
	} else {
		await expect(
			page.getByRole("button", { name: /Model: Alpha model\./ }),
		).toHaveCount(0);
	}
	await new SidebarPage(page).clickSession(alphaSession);
	await expect(page.locator("#input")).toHaveValue(
		`Prompt for ${alphaSession}`,
	);
	releaseSecond();
	await expect(await openModels(page)).toContainText("Alpha model");
	await expect(page.getByTestId("model-picker-list")).not.toContainText(
		"Second model",
	);
	await capture(page, testInfo, "alpha-after-fast-switch");
	await closePicker(page);
	await new SidebarPage(page).clickSession(secondSession);
	await expect(await openModels(page)).toContainText("Second model");
	await expect(page.getByTestId("model-picker-trigger")).toHaveAttribute(
		"aria-label",
		/Second model/,
	);
});

test("a new draft's model, agent and command lists match its project", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message),
	);
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	try {
		await page.goto(`${harness.relayBaseUrl}/new?project=beta`);
		await expect(page).toHaveURL(/project=beta/);
		await rpc.waitForRequest(
			(request) =>
				request.tag === "SubscribeDraftModels" &&
				request.payload["projectSlug"] === "beta",
		);
		await expect(page.getByTestId("model-picker-trigger")).toHaveAttribute(
			"data-shown-model",
			"beta-model",
		);
		await expect(page.getByTestId("model-picker-trigger")).toHaveAttribute(
			"aria-label",
			/Model: Beta model/,
		);
		await expect(await openModels(page)).toContainText("Beta model");
		await expect(page.getByTestId("model-picker-list")).not.toContainText(
			"Alpha model",
		);
		await closePicker(page);
		await openPickerRoot(page, page.getByTestId("model-picker-trigger"));
		await expect(page.getByTestId("picker-row-agent")).toContainText(
			"Beta agent",
		);
		await expect(page.getByTestId("picker-row-agent")).not.toContainText(
			"Alpha agent",
		);
		await closePicker(page);
		await page.locator("#input").fill("/");
		await expect(page.locator("#command-menu")).toContainText("/beta-command");
		await expect(page.locator("#command-menu")).not.toContainText(
			"/alpha-command",
		);
		await capture(page, testInfo, "new-beta-draft-commands");
	} finally {
		const path = testInfo.outputPath("new-draft-catalog-wire.json");
		await writeFile(
			path,
			JSON.stringify(
				{
					pageErrors,
					modelTrigger: await page
						.getByTestId("model-picker-trigger")
						.evaluateAll((nodes) =>
							nodes.map((node) => ({
								label: node.getAttribute("aria-label"),
								model: node.getAttribute("data-shown-model"),
								expanded: node.getAttribute("aria-expanded"),
							})),
						),
					requests: rpc
						.getRequests()
						.filter((request) =>
							[
								"AttachProject",
								"GetModels",
								"GetAgents",
								"GetCommands",
								"SubscribeDraftModels",
							].includes(request.tag),
						),
				},
				null,
				2,
			),
		);
		await testInfo.attach("new-draft-catalog-wire", {
			path,
			contentType: "application/json",
		});
	}
});
