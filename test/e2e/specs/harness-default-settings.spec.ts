import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { Effect, Result as Either, Schema } from "effect";
import {
	ProjectSettingSchema,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { Harness } from "../../../src/lib/provider/turn-settings.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type { RelaySettings } from "../../../src/lib/relay/relay-settings.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const claudeModels: readonly ModelInfo[] = [
	{
		id: "sonnet",
		name: "Sonnet",
		providerId: "claude",
		variants: { low: {}, high: {} },
		contextWindowOptions: [
			{ value: "200k", label: "200k", isDefault: true },
			{ value: "1m", label: "1M" },
		],
	},
	{
		id: "opus",
		name: "Opus",
		providerId: "claude",
		variants: { high: {}, max: {} },
		contextWindowOptions: [
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		],
	},
];
const openCodePick = {
	providerId: "opencode",
	modelId: "nemotron-3-super-free",
	effort: "",
	contextWindow: "",
};
const legacySettings: RelaySettings = {
	defaultModel: "claude/sonnet",
	defaultVariants: { "claude/sonnet": "low", "claude/opus": "high" },
};

test.describe.configure({ mode: "default" });
test.setTimeout(120_000);
test.use({
	harnessOptions: {
		opencodeRecording: "chat-simple",
		capabilityModels: claudeModels,
		relaySettings: legacySettings,
	},
});

const field = (page: Page, harness: Harness, name: string) =>
	page.getByTestId(`settings-harness-default-${harness}-${name}`);

function stored(harness: ProcessHarness): RelaySettings {
	const file = join(harness.configDir, "settings.jsonc");
	return existsSync(file)
		? (JSON.parse(readFileSync(file, "utf8")) as RelaySettings)
		: {};
}

function latestDefaults(browser: ProcessBrowser) {
	const frame = browser.frames
		.slice()
		.reverse()
		.find(
			({ message }) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "harnessDefaults",
		);
	if (!frame) return undefined;
	const row = Schema.decodeUnknownSync(ProjectSettingSchema)(frame.message);
	return row._tag === "harnessDefaults" ? row : undefined;
}

async function openSettings(
	page: Page,
	harness: ProcessHarness,
): Promise<void> {
	await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
	const listOverflow = page.getByTestId("list-bar-overflow");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-models").click();
	await field(page, "claude", "model").waitFor();
	await page.waitForFunction(
		() =>
			Boolean(
				document.querySelector(
					'[data-testid="settings-harness-default-claude-model"] optgroup',
				),
			) &&
			document
				.querySelector('[data-testid="settings-harness-default-claude-status"]')
				?.getAttribute("data-status") !== "unverified",
	);
}

async function shown(page: Page) {
	const rows = await Promise.all(
		(["claude", "opencode"] as const).map(async (harness) => {
			const model = field(page, harness, "model");
			const effort = field(page, harness, "effort");
			const context = field(page, harness, "context");
			const status = field(page, harness, "status");
			return [
				harness,
				{
					model: await model.inputValue(),
					flagged: (await model.getAttribute("aria-invalid")) === "true",
					selectedDisabled: await model.evaluate(
						(select: HTMLSelectElement) =>
							select.selectedOptions[0]?.disabled ?? false,
					),
					effort: (await effort.count()) ? await effort.inputValue() : "",
					contextWindow: (await context.count())
						? await context.inputValue()
						: "",
					status: (await status.count())
						? await status.getAttribute("data-status")
						: "ok",
					problem: (await status.count()) ? await status.textContent() : null,
				},
			] as const;
		}),
	);
	return Object.fromEntries(rows);
}

async function artifact(
	testInfo: TestInfo,
	name: string,
	page: Page,
	harness: ProcessHarness,
	rpc?: unknown,
) {
	const values = await shown(page);
	const evidence = {
		case: name,
		shown: values,
		stored: stored(harness),
		...(rpc ? { rpc } : {}),
		status: {
			claude: values["claude"]?.status,
			opencode: values["opencode"]?.status,
		},
	};
	const file = testInfo.outputPath(`${name}.json`);
	writeFileSync(file, JSON.stringify(evidence, null, 2));
	await testInfo.attach(name, { path: file, contentType: "application/json" });
	return evidence;
}

test("legacy Claude default seeds only Claude without rewriting settings", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	await browser.startInstance("opencode");
	await openSettings(page, harness);
	const evidence = await artifact(testInfo, "1-legacy", page, harness);
	expect(evidence.shown["claude"]).toMatchObject({
		model: "claude/sonnet",
		effort: "low",
		status: "ok",
	});
	// chat-simple has no /config recording and therefore no native default.
	expect(evidence.shown["opencode"]).toMatchObject({
		model: "",
		status: "missing",
	});
	expect(evidence.stored).toEqual(legacySettings);
});

test("UI persists model effort and context and preserves the other harness", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	await Effect.runPromise(
		browser.rpc.SetHarnessDefault({
			projectSlug: "process-test",
			harness: "opencode",
			...openCodePick,
		}),
	);
	await openSettings(page, harness);
	await field(page, "claude", "model").selectOption("claude/opus");
	await page
		.locator(
			'[data-testid="settings-harness-default-claude-model"]:not(:disabled)',
		)
		.waitFor();
	const remembered = await artifact(testInfo, "2-model-memory", page, harness);
	expect(remembered.shown["claude"]).toMatchObject({
		model: "claude/opus",
		effort: "high",
		contextWindow: "",
	});
	await field(page, "claude", "effort").selectOption("max");
	await field(page, "claude", "context").selectOption("1m");
	await page.waitForFunction(() => {
		const select = document.querySelector<HTMLSelectElement>(
			'[data-testid="settings-harness-default-claude-context"]',
		);
		return select?.value === "1m" && !select.disabled;
	});
	await page.reload();
	await openSettings(page, harness);
	const evidence = await artifact(testInfo, "2-persist-reload", page, harness);
	expect(evidence.shown["claude"]).toMatchObject({
		model: "claude/opus",
		effort: "max",
		contextWindow: "1m",
		status: "ok",
	});
	expect(evidence.stored.harnessDefaults).toEqual({
		claude: { providerId: "claude", modelId: "opus", contextWindow: "1m" },
		opencode: {
			providerId: openCodePick.providerId,
			modelId: openCodePick.modelId,
			contextWindow: "",
		},
	});
	expect(evidence.stored.defaultVariants?.["claude/opus"]).toBe("max");
	expect(evidence.stored.defaultModel).toBe("claude/sonnet");
});

test("RPC rejects the other harness and unoffered choices without writing", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	await openSettings(page, harness);
	const before = readFileSync(
		join(harness.configDir, "settings.jsonc"),
		"utf8",
	);
	for (const rejection of [
		{ name: "3-model", tag: "ModelNotInCatalog", pick: openCodePick },
		{
			name: "3-anthropic-namespace",
			tag: "ModelNotInCatalog",
			pick: { ...openCodePick, providerId: "anthropic" },
		},
		{
			name: "3-effort",
			tag: "EffortNotOffered",
			pick: {
				providerId: "claude",
				modelId: "sonnet",
				effort: "max",
				contextWindow: "",
			},
		},
		{
			name: "3-context",
			tag: "ContextWindowNotOffered",
			pick: {
				providerId: "claude",
				modelId: "opus",
				effort: "",
				contextWindow: "2m",
			},
		},
	]) {
		const result = await Effect.runPromise(
			Effect.result(
				browser.rpc.SetHarnessDefault({
					projectSlug: "process-test",
					harness: "claude",
					...rejection.pick,
				}),
			),
		);
		const message =
			Either.isFailure(result) && result.failure instanceof WsRpcError
				? result.failure.message
				: null;
		const after = readFileSync(
			join(harness.configDir, "settings.jsonc"),
			"utf8",
		);
		await artifact(testInfo, rejection.name, page, harness, {
			result: result._tag,
			message,
			before,
			after,
		});
		expect(message).toMatch(new RegExp(`^${rejection.tag}:`));
		expect(after).toBe(before);
	}
	const result = await Effect.runPromise(
		Effect.result(
			browser.rpc.SetDefaultModel({
				projectSlug: "process-test",
				provider: "claude",
				model: "retired-sonnet",
			}),
		),
	);
	const message =
		Either.isFailure(result) && result.failure instanceof WsRpcError
			? result.failure.message
			: null;
	const after = readFileSync(join(harness.configDir, "settings.jsonc"), "utf8");
	await artifact(testInfo, "3-star-rejection", page, harness, {
		result: result._tag,
		message,
		before,
		after,
	});
	expect(message).toMatch(/^ModelNotInCatalog:/);
	expect(after).toBe(before);
});

test("defaults follow RPC writes across relays", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const directory = join(harness.root, "other-default-project");
	mkdirSync(directory);
	const { savedSlug } = await Effect.runPromise(
		browser.rpc.SaveProject({ folders: [directory] }),
	);
	if (!savedSlug) throw new Error("SaveProject omitted the slug");
	const other = await harness.connect(undefined, undefined, savedSlug);
	await Effect.runPromise(
		other.rpc.GetModels({ projectSlug: savedSlug, instanceId: "claude" }),
	);
	await openSettings(page, harness);
	await Effect.runPromise(
		browser.rpc.SetHarnessDefault({
			projectSlug: "process-test",
			harness: "claude",
			providerId: "claude",
			modelId: "opus",
			effort: "max",
			contextWindow: "1m",
		}),
	);
	await other.waitFor(
		() =>
			latestDefaults(other)?.claude?.pick?.modelId === "opus" &&
			latestDefaults(other)?.claude?.status === "ok",
	);
	await page.waitForFunction(
		() =>
			document.querySelector<HTMLSelectElement>(
				'[data-testid="settings-harness-default-claude-model"]',
			)?.value === "claude/opus",
	);
	const published = latestDefaults(other);
	await artifact(testInfo, "5-relay-fanout", page, harness, {
		otherRelay: savedSlug,
		published,
	});
	expect(published?.claude).toMatchObject({
		status: "ok",
		pick: { modelId: "opus", effort: "max", contextWindow: "1m" },
	});
});

test.describe("foreign stored pick", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: claudeModels,
			relaySettings: {
				...legacySettings,
				harnessDefaults: {
					claude: {
						providerId: "anthropic",
						modelId: "foreign-default",
						contextWindow: "",
					},
				},
			},
		},
	});
	test("flags the seeded pick instead of falling back to the legacy default", async ({
		page,
		harness,
	}, testInfo) => {
		const browser = await harness.connect();
		await openSettings(page, harness);
		await browser.waitFor(
			() => latestDefaults(browser)?.claude?.status === "invalid",
		);
		const evidence = await artifact(
			testInfo,
			"5-stored-foreign",
			page,
			harness,
			{ published: latestDefaults(browser) },
		);
		expect(evidence.shown["claude"]).toMatchObject({
			model: "anthropic/foreign-default",
			flagged: true,
			selectedDisabled: true,
			status: "invalid",
		});
		expect(latestDefaults(browser)?.claude?.problem).toMatch(
			/^ModelNotInCatalog:/,
		);
	});
});

test.describe("no OpenCode catalog", () => {
	test.use({
		harnessOptions: {
			capabilityModels: claudeModels,
			managedOpenCode: true,
			relaySettings: {
				harnessDefaults: {
					opencode: {
						providerId: openCodePick.providerId,
						modelId: openCodePick.modelId,
						contextWindow: "",
					},
				},
			},
		},
	});
	test("shows an unverified stored pick without starting OpenCode", async ({
		page,
		harness,
	}, testInfo) => {
		await openSettings(page, harness);
		const evidence = await artifact(testInfo, "6-unverified", page, harness, {
			ownedOpenCodePids: harness.ownedOpenCodePids(),
		});
		expect(evidence.shown["opencode"]).toMatchObject({
			model: "opencode/nemotron-3-super-free",
			status: "unverified",
			selectedDisabled: true,
		});
		expect(evidence.shown["opencode"]?.problem).toBe(
			"Start OpenCode to check this default.",
		);
		expect(harness.ownedOpenCodePids()).toEqual([]);
	});
});

test.describe("unavailable stored model", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: claudeModels,
			relaySettings: {
				harnessDefaults: {
					claude: {
						providerId: "claude",
						modelId: "retired-sonnet",
						contextWindow: "",
					},
				},
			},
		},
	});
	test("flags the stored pick and keeps both harness rows visible", async ({
		page,
		harness,
	}, testInfo) => {
		await openSettings(page, harness);
		const evidence = await artifact(testInfo, "4-invalid", page, harness);
		if (testInfo.project.name === "desktop") {
			mkdirSync("/tmp/fmg0/fmg03", { recursive: true });
			await page
				.locator("#settings-default-models")
				.screenshot({ path: "/tmp/fmg0/fmg03/settings.png" });
			await testInfo.attach("Default models", {
				path: "/tmp/fmg0/fmg03/settings.png",
				contentType: "image/png",
			});
		}
		expect(evidence.shown["claude"]).toMatchObject({
			model: "claude/retired-sonnet",
			flagged: true,
			selectedDisabled: true,
			status: "invalid",
		});
		expect(evidence.shown["claude"]?.problem).toContain(
			"retired-sonnet is no longer available",
		);
	});
});
