import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: reading the native default starts or probes a stopped instance,
// the first catalog entry overrides the project config, the browser never hears
// the hydrated default, or discovery after stop starts the instance again.
describe("OpenCode project model catalog", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["requests"] = fixture.opencodeRequests();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/rqbc-6-model-catalog.json",
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("selects the project-config default once OpenCode runs and never starts it for discovery", async () => {
		evidence = { ticket: "conduit-test-rqbc.6", at: new Date().toISOString() };
		const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		writeFileSync(
			join(fixture.projectDir, "opencode.json"),
			JSON.stringify({ model: "fake/model-b" }),
		);
		writeFileSync(
			join(fixture.configDir, "fake-opencode-model-catalog.json"),
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Fake",
						models: {
							"model-a": {
								id: "model-a",
								name: "A",
								limit: { context: 128000, output: 4096 },
							},
							"model-b": {
								id: "model-b",
								name: "B",
								limit: { context: 128000, output: 4096 },
							},
						},
					},
				],
				default: { fake: "model-a" },
				connected: ["fake"],
			}),
		);
		await fixture.restart();
		const browser = await fixture.connect();
		evidence["cold"] = await browser.getModels(instanceId);
		expect(fixture.opencodeRequests()).toEqual([]);
		expect(fixture.ownedOpenCodePids()).toHaveLength(0);
		await browser.startInstance(instanceId);
		const cursor = browser.frames.length;
		const live = await browser.getModels(instanceId);
		evidence["live"] = live;
		expect(live.providers[0]?.models.map(({ id }) => id)).toEqual([
			"model-a",
			"model-b",
		]);
		expect(live.active).toEqual({ provider: "fake", model: "model-b" });
		evidence["defaultUpdate"] = await browser.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "defaultModel" &&
				message["provider"] === "fake" &&
				message["model"] === "model-b",
			cursor,
		);
		const configRequest = fixture
			.opencodeRequests()
			.find(({ url }) => url.split("?")[0] === "/config");
		expect(configRequest).toBeDefined();
		const directory =
			new URL(
				configRequest?.url ?? "/",
				"http://opencode.test",
			).searchParams.get("directory") ?? configRequest?.directory;
		expect(directory).toBeDefined();
		expect(realpathSync(decodeURIComponent(directory ?? ""))).toBe(
			realpathSync(fixture.projectDir),
		);
		await browser.stopInstance(instanceId);
		const requestCount = fixture.opencodeRequests().length;
		const stopped = await browser.getModels(instanceId);
		evidence["stopped"] = stopped;
		expect(stopped.active).toEqual(live.active);
		expect(stopped.providers).toEqual(live.providers);
		expect(fixture.opencodeRequests()).toHaveLength(requestCount);
		expect((await browser.instanceStatus(instanceId)).instance?.status).toBe(
			"stopped",
		);
		await browser.close();
	}, 120_000);
});
