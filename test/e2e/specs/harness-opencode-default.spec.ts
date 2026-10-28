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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({
	harnessOptions: {
		managedOpenCode: true,
		managedOpenCodeId: "opencode",
		relaySettings: {
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
		// Prove the relay can actually create/send on its non-home server.
		await new AppPage(page).sendMessage("selected server draft");
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		await expect
			.poll(() =>
				harness
					.opencodeRequestBodies()
					.some(
						({ body, path }) =>
							path.endsWith("/prompt_async") &&
							body.includes("selected server draft"),
					),
			)
			.toBe(true);
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
		await expect
			.poll(() =>
				harness
					.opencodeRequestBodies()
					.some(
						({ path, body }) =>
							path.endsWith("/prompt_async") &&
							body.includes("managed existing session"),
					),
			)
			.toBe(true);
		const claude = await browser.createSession();
		await browser.send(
			claude,
			"Generate a title while the selected OpenCode is stopped",
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
		evidence["duringOutageDefaults"] = saved().accountDefaults;
		evidence["titleRequests"] = harness.claudeTitles();
		writeFileSync(
			join(harness.configDir, "fake-opencode-discovery.json"),
			JSON.stringify({ agents: [{ name: "title", mode: "subagent" }] }),
		);
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
		const openCodeTitleSession = await browser.createSession();
		await browser.send(
			openCodeTitleSession,
			"Generate an OpenCode title during the outage",
		);
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
		};
		evidence["storedSettings"] = JSON.parse(settings());
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
		const directory = resolve("artifacts/conduit-test-3fc0.7");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, `${testInfo.project.name}.json`),
			`${JSON.stringify(evidence, null, "\t")}\n`,
		);
	}
});
