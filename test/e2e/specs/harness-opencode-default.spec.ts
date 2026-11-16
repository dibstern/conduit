/*
 * Failure modes, recorded before changing backend resolution:
 * - AccountDirectory.defaultFor/resolve can route legacy or deleted bindings and
 *   DriverDefault title accounts to the down selection instead of managed.
 * - session-command's missing-row rename/delete and missing-parent fork can
 *   contact the down selection, breaking upstream work on existing sessions.
 * - ProviderAdapters' unbound session client can contact the down selection.
 * - loadModelCatalog and loadServerSessionPick can validate server-created picks
 *   against the down selection, breaking creation/forks and catalog reads.
 * - GetModels' OpenCode presence read and SwitchModel's cross-harness fallback
 *   can depend on the down selection instead of managed.
 * - Drafts can retain the relay's home account, persist a temporary fallback,
 *   or remain on managed after the selected server returns.
 * - A non-home draft can display one account but create/send on another.
 * - OpenCode title generation can succeed only through the live managed
 *   DriverDefault, including its isolated server's synchronous title reply
 *   and boolean abort response during cleanup.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result } from "effect";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

async function expectPromptOnServer(
	harness: ProcessHarness,
	sessionId: string | undefined,
	accountId: string,
	serverPid: number,
	text: string,
) {
	if (!sessionId) throw new Error("Missing draft session id");
	const db = new DatabaseSync(harness.daemonStorePath(), { readOnly: true });
	let binding: { accountId: string; providerSessionId: string } | undefined;
	try {
		binding = db
			.prepare(
				`SELECT binding.provider AS accountId,
				 COALESCE(session.provider_sid, session.id) AS providerSessionId
				 FROM session_providers AS binding
				 JOIN sessions AS session ON session.id = binding.session_id
				 WHERE binding.session_id = ? AND binding.status = 'active'`,
			)
			.get(sessionId) as typeof binding;
	} finally {
		db.close();
	}
	if (!binding) throw new Error("Missing active OpenCode binding");
	expect(binding.accountId).toBe(accountId);
	// OpenCode keeps its native id as the Conduit id; the binding's provider_sid
	// is not populated by the session.created projector.
	expect(binding.providerSessionId).toBe(sessionId);
	const path = `/session/${binding.providerSessionId}/prompt_async`;
	const receivingRequest = () =>
		harness
			.opencodeRequestBodies()
			.find(
				(request) =>
					request.method === "POST" &&
					request.path === path &&
					request.body.includes(text),
			);
	await expect.poll(receivingRequest).toMatchObject({ pid: serverPid, path });
	return {
		sessionId,
		...binding,
		expectedPid: serverPid,
		receivingPid: receivingRequest()?.pid,
		path,
	};
}

function writeEvidence(project: string, evidence: Record<string, unknown>) {
	const directory = resolve("test/e2e/opencode-default/artifacts");
	mkdirSync(directory, { recursive: true });
	const path = join(mkdtempSync(join(directory, `${project}-`)), "report.json");
	writeFileSync(path, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`OpenCode default evidence: ${path}`);
}

test.use({
	harnessOptions: {
		managedOpenCode: true,
		managedOpenCodeId: "opencode",
		globalSettings: {
			defaultModel: "fake/fake-model",
			harnessDefaults: {
				opencode: {
					providerId: "fake",
					modelId: "fake-model",
					contextWindow: "",
				},
			},
		},
	},
});
test.setTimeout(120_000);

if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

test("OpenCode selection survives an outage while drafts fall back and recover", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const rpc = browser.rpc;
	await browser.startInstance("opencode");
	const existing = await browser.createSession(
		"Existing managed session",
		"opencode",
		"opencode",
		{
			modelProviderId: "fake",
			modelId: "fake-model",
			variant: "",
			contextWindow: "",
		},
	);
	const added = await Effect.runPromise(
		rpc.AddInstance({
			name: "Selected OpenCode",
			driver: "opencode",
			managed: true,
			port: 0,
			env: { CONDUIT_TEST_OPENCODE_STATE_PREFIX: "selected" },
		}),
	);
	const selected = added.addedInstanceId;
	if (!selected) throw new Error("Missing selected OpenCode id");
	await browser.startInstance(selected);
	const running = (await browser.instances()).instances;
	const selectedPid = running.find((instance) => instance.id === selected)?.pid;
	const managedPid = running.find(
		(instance) => instance.id === "opencode",
	)?.pid;
	if (selectedPid === undefined || managedPid === undefined)
		throw new Error("Missing selected or managed OpenCode pid");
	const reply = await Effect.runPromise(
		rpc.SetDefault({ instanceId: selected }),
	);
	expect(
		reply.instances
			.filter((i) => i.driver === "opencode" && i.isDefault)
			.map((i) => i.id),
	).toEqual([selected]);
	const saved = () =>
		JSON.parse(
			readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
		) as { accountDefaults: Record<string, string> };
	const settings = () =>
		readFileSync(join(harness.configDir, "settings.jsonc"), "utf8");
	const evidence: Record<string, unknown> = {
		selected,
		existing,
		selectedDefaults: saved().accountDefaults,
	};
	const titleRequests = (text: string) =>
		harness
			.opencodeRequestBodies()
			.filter(
				({ method, path, body }) =>
					method === "POST" && path.endsWith("/message") && body.includes(text),
			);
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
	);
	const openDraft = async (account: string) => {
		await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
		await page.locator("#new-session-btn:visible").click();
		await expect(picker).toHaveAttribute("data-instance-id", account);
		await expect(picker).toHaveAttribute("data-shown-model", "fake-model");
		return {
			account: await picker.getAttribute("data-instance-id"),
			model: await picker.getAttribute("data-shown-model"),
		};
	};
	try {
		evidence["beforeOutage"] = await openDraft(selected);
		// Prove the relay creates and sends on the selected concrete server.
		await new AppPage(page).sendMessage("selected server draft");
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		evidence["selectedDraftRequest"] = await expectPromptOnServer(
			harness,
			new URL(page.url()).pathname.split("/").at(-1),
			selected,
			selectedPid,
			"selected server draft",
		);
		const claude = await browser.createSession();
		await browser.send(
			claude,
			"Generate a built-in title before the OpenCode preference changes",
		);
		await expect
			.poll(
				async () =>
					(
						await Effect.runPromise(
							rpc.ListDaemonSessions({ projectSlug: "process-test" }),
						)
					).sessions.find((s) => s.id === claude)?.title,
			)
			.toBe("Process harness session");
		evidence["titleRequests"] = harness.claudeTitles();
		writeFileSync(
			join(harness.configDir, "fake-opencode-discovery.json"),
			JSON.stringify({ agents: [{ name: "title", mode: "subagent" }] }),
		);
		await page
			.locator(
				'[data-testid="session-bar-overflow"]:visible, [data-testid="session-bar-island-overflow"]:visible',
			)
			.click();
		await page.getByTestId("overflow-settings").click();
		await page.getByTestId("settings-tab-models").click();
		await page.getByTestId("settings-title-generation-picker").click();
		const titlePicker = page.getByTestId("title-generation-picker");
		await titlePicker.getByTestId("picker-harness-opencode").click();
		await expect(titlePicker).toHaveAttribute("aria-busy", "false");
		expect(JSON.parse(settings()).titleGeneration.account).toEqual({
			_tag: "DriverDefault",
			driver: "opencode",
		});
		await titlePicker.getByTestId("picker-row-model").click();
		await titlePicker
			.locator('[data-model-id="fake-model"][data-provider-id="fake"]')
			.click();
		await expect(titlePicker).toHaveAttribute("aria-busy", "false");
		expect(JSON.parse(settings()).titleGeneration).toMatchObject({
			account: { _tag: "DriverDefault", driver: "opencode" },
			providerId: "fake",
			modelId: "fake-model",
		});
		await Effect.runPromise(
			rpc.SetTitleGeneration({
				projectSlug: "process-test",
				selection: {
					account: { _tag: "DriverDefault", driver: "opencode" },
					providerId: "fake",
					modelId: "fake-model",
					effort: "",
				},
			}),
		);
		const healthyTitleSession = await browser.createSession();
		const healthyTitleMessage = "Generate an OpenCode title before the outage";
		await browser.send(healthyTitleSession, healthyTitleMessage);
		await expect
			.poll(
				async () =>
					(
						await Effect.runPromise(
							rpc.ListDaemonSessions({ projectSlug: "process-test" }),
						)
					).sessions.find((s) => s.id === healthyTitleSession)?.title,
			)
			.toBe("Managed OpenCode title");
		// Titles run on an isolated server that inherits the chosen account's
		// env, so the state prefix (not the pid) names the account that served it.
		evidence["healthyOpenCodeTitle"] = {
			sessionId: healthyTitleSession,
			expectedStatePrefix: "selected",
			requests: titleRequests(healthyTitleMessage),
		};
		expect(
			titleRequests(healthyTitleMessage).map((r) => r.statePrefix),
		).toEqual(["selected"]);
		await page.goto("about:blank");
		await browser.stopInstance(selected);
		const storedAfterStop = saved().accountDefaults;
		const settingsAfterStop = settings();
		evidence["duringOutage"] = await openDraft("opencode");
		expect(saved().accountDefaults).toEqual(storedAfterStop);
		expect(saved().accountDefaults["opencode"]).toBe(selected);
		expect(settings()).toBe(settingsAfterStop);
		evidence["fallbackWroteSettings"] = false;
		expect(
			(await browser.instances()).instances.find((i) => i.id === selected)
				?.status,
		).toBe("stopped");
		const catalog = await browser.getModels();
		expect(catalog.providers.some((p) => p.id === "fake")).toBe(true);
		expect(catalog).not.toHaveProperty("defaultOpenCodeInstanceId");
		await Effect.runPromise(
			rpc.RenameSession({
				sessionId: existing,
				title: "Still managed during outage",
			}),
		);
		await Effect.runPromise(
			rpc["input.submit"]({
				sessionId: existing,
				originId: browser.originId,
				inputId: "existing-during-outage",
				text: "managed existing session",
				delivery: "queue",
			}),
		);
		evidence["existingSessionRequest"] = await expectPromptOnServer(
			harness,
			existing,
			"opencode",
			managedPid,
			"managed existing session",
		);
		evidence["duringOutageDefaults"] = saved().accountDefaults;
		const openCodeTitleSession = await browser.createSession();
		const outageTitleMessage = "Generate an OpenCode title during the outage";
		await browser.send(openCodeTitleSession, outageTitleMessage);
		await expect
			.poll(
				async () =>
					(
						await Effect.runPromise(
							rpc.ListDaemonSessions({ projectSlug: "process-test" }),
						)
					).sessions.find((s) => s.id === openCodeTitleSession)?.title,
			)
			.toBe("Managed OpenCode title");
		evidence["openCodeTitle"] = {
			sessionId: openCodeTitleSession,
			title: "Managed OpenCode title",
			expectedStatePrefix: null,
			requests: titleRequests(outageTitleMessage),
		};
		// The managed account sets no state prefix.
		expect(titleRequests(outageTitleMessage).map((r) => r.statePrefix)).toEqual(
			[undefined],
		);
		evidence["storedSettings"] = JSON.parse(settings());
		expect(JSON.parse(settings()).titleGeneration.account).toEqual({
			_tag: "DriverDefault",
			driver: "opencode",
		});
		expect(
			(await browser.instances()).instances.find((i) => i.id === selected)
				?.status,
		).toBe("stopped");
		await browser.startInstance(selected);
		// The open, untouched fallback draft follows health updates too.
		await expect(picker).toHaveAttribute("data-instance-id", selected);
		evidence["recovered"] = await openDraft(selected);
		expect(saved().accountDefaults["opencode"]).toBe(selected);
	} finally {
		evidence["titleGenerationLog"] = harness.logTail
			.split("\n")
			.filter((line) => line.includes("SESSION_TITLE"))
			.join("\n");
		evidence["textGenerationRequests"] = harness
			.opencodeRequestBodies()
			.filter(
				({ method, path }) => method === "POST" && path.endsWith("/message"),
			);
		writeEvidence(testInfo.project.name, evidence);
	}
});

test.describe("named OpenCode selection", () => {
	test.use({ startHarness: false });

	test("an unavailable named selection sends its fallback draft to managed OpenCode", async ({
		page,
		harness,
	}, testInfo) => {
		const configPath = join(harness.configDir, "daemon.json");
		// The unstarted harness seeds legacy config. Normalize it before adding
		// modern account defaults, or legacy decoding replaces those defaults.
		const config = Result.getOrThrow(loadDaemonConfigResult(harness.configDir));
		const managed = config?.instances?.find(({ id }) => id === "opencode");
		if (!config || !managed) throw new Error("Missing managed fixture config");
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				instances: [
					managed,
					{
						...managed,
						id: "remote",
						name: "Named selection",
						env: {
							...managed.env,
							CONDUIT_TEST_OPENCODE_STATE_PREFIX: "remote",
						},
					},
				],
				accountDefaults: { ...config.accountDefaults, opencode: "remote" },
			}),
		);
		await harness.restart();
		const browser = await harness.connect();
		await browser.startInstance("remote");
		await browser.startInstance("opencode");
		const running = (await browser.instances()).instances;
		const selectedPid = running.find(
			(instance) => instance.id === "remote",
		)?.pid;
		const managedPid = running.find(
			(instance) => instance.id === "opencode",
		)?.pid;
		if (selectedPid === undefined || managedPid === undefined)
			throw new Error("Missing selected or managed OpenCode pid");
		const evidence: Record<string, unknown> = {
			selected: "remote",
			selectedPid,
			managedPid,
			instances: running,
		};
		try {
			expect(
				running.filter(
					(instance) => instance.driver === "opencode" && instance.isDefault,
				),
			).toMatchObject([{ id: "remote", status: "healthy" }]);
			expect(selectedPid).not.toBe(managedPid);
			const picker = page.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
			);
			await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
			await page.locator("#new-session-btn:visible").click();
			await expect(picker).toHaveAttribute("data-instance-id", "remote");
			await expect(picker).toHaveAttribute("data-shown-model", "fake-model");
			await new AppPage(page).sendMessage("named selected draft");
			await expect(page).toHaveURL(/\/s\/[^/?]+/);
			evidence["selectedDraftRequest"] = await expectPromptOnServer(
				harness,
				new URL(page.url()).pathname.split("/").at(-1),
				"remote",
				selectedPid,
				"named selected draft",
			);
			await page.goto("about:blank");
			await browser.stopInstance("remote");
			await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
			await page.locator("#new-session-btn:visible").click();
			await expect(picker).toHaveAttribute("data-instance-id", "opencode");
			await expect(picker).toHaveAttribute("data-shown-model", "fake-model");
			await new AppPage(page).sendMessage("named selection managed fallback");
			await expect(page).toHaveURL(/\/s\/[^/?]+/);
			evidence["fallbackDraftRequest"] = await expectPromptOnServer(
				harness,
				new URL(page.url()).pathname.split("/").at(-1),
				"opencode",
				managedPid,
				"named selection managed fallback",
			);
			expect(
				(await browser.instances()).instances.find(
					(instance) => instance.id === "remote",
				)?.status,
			).toBe("stopped");
			const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
				accountDefaults: Record<string, string>;
			};
			expect(saved.accountDefaults["opencode"]).toBe("remote");
			evidence["duringOutageDefaults"] = saved.accountDefaults;
		} finally {
			writeEvidence(`${testInfo.project.name}-named-selection`, evidence);
		}
	});
});
