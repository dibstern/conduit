import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: relay startup probing OpenCode, browser attach listing
// providers/agents/pending prompts from OpenCode, the model picker losing
// OpenCode models once nothing is fetched at attach, and Start/Stop Instance
// not reaching the process through OpenCode Instances.
describe("OpenCode stays quiet at relay startup and browser attach", () => {
	const instanceId = defaultInstanceIdForDriver("opencode");
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
					"test-results/pa3r-6-startup-quiet.json",
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("makes no OpenCode requests until an OpenCode session exists, then serves its models and Start/Stop", async () => {
		evidence = { ticket: "conduit-test-pa3r.6", at: new Date().toISOString() };
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart();
		const first = await fixture.connect();
		await vi.waitFor(
			async () =>
				expect((await first.instanceStatus(instanceId)).instance?.status).toBe(
					"healthy",
				),
			{ timeout: 10_000 },
		);
		await first.close();

		// Restart the daemon against the still-running OpenCode so relay startup
		// and attach both happen while it is reachable.
		await fixture.terminate();
		const startedAt = Date.now();
		await fixture.restart();
		const browser = await fixture.connect();
		// context_window_info is the last frame of the attach sequence.
		await browser.waitFor(
			(message) => message["type"] === "context_window_info",
		);
		await new Promise<void>((done) => setTimeout(done, 1500));
		const window = fixture
			.opencodeRequests()
			.filter(({ at }) => at >= startedAt);
		const quiet = window.filter(({ url }) => url !== "/global/health");
		evidence["startupAndAttach"] = {
			startedAt,
			endedAt: Date.now(),
			healthChecks: window.length - quiet.length,
			otherRequests: quiet,
		};
		expect(window.length).toBeGreaterThan(0);
		expect(quiet).toEqual([]);

		const sessionId = await browser.createSession(
			"OpenCode",
			undefined,
			"opencode",
		);
		const models = await browser.getModels();
		const fake = models.providers.find(({ id }) => id === "fake");
		evidence["modelPicker"] = {
			sessionId,
			providers: models.providers.map(({ id, models }) => ({
				id,
				models: models.map((model) => model.id),
			})),
		};
		expect(fake?.models.map(({ id }) => id)).toEqual(["fake-model"]);

		const pids = () =>
			readFileSync(join(fixture.configDir, "fake-opencode-pids.jsonl"), "utf8")
				.trim()
				.split("\n");
		const spawnsBefore = pids().length;
		await browser.stopInstance(instanceId);
		const stopped = (await browser.instanceStatus(instanceId)).instance?.status;
		await browser.startInstance(instanceId);
		await vi.waitFor(
			async () =>
				expect(
					(await browser.instanceStatus(instanceId)).instance?.status,
				).toBe("healthy"),
			{ timeout: 10_000 },
		);
		const afterRestart = await browser.getModels();
		evidence["startStop"] = {
			stopped,
			spawnsBefore,
			spawnsAfter: pids().length,
			providersAfter: afterRestart.providers.map(({ id }) => id),
		};
		expect(stopped).toBe("stopped");
		expect(pids().length).toBe(spawnsBefore + 1);
		expect(afterRestart.providers.map(({ id }) => id)).toContain("fake");
	});
});
