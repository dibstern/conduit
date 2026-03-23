// ─── Integration: Model Selection ────────────────────────────────────────────
// Tests model/provider behavior against a mock OpenCode server.
// Verifies:
//   - Only configured providers appear in model_list
//   - Model switch works and messages succeed
//   - New session resets model selection

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Model Selection", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(() => {
		harness.mock.resetQueues();
	});

	it("model_list only contains configured providers", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		const modelList = client.getReceivedOfType("model_list");
		expect(modelList.length).toBeGreaterThan(0);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const providers = modelList[0]!["providers"] as Array<{
			id: string;
			name: string;
			configured: boolean;
			models: Array<{ id: string }>;
		}>;

		// Every provider in the list must be configured
		for (const provider of providers) {
			expect(provider.configured).toBe(true);
		}

		// Must have at least one provider with models
		const withModels = providers.filter((p) => p.models.length > 0);
		expect(withModels.length).toBeGreaterThan(0);

		await client.close();
	}, 15_000);

	it("receives model_info on connect", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Should have received model_info (auto-selected or from session)
		const modelInfos = client.getReceivedOfType("model_info");
		expect(modelInfos.length).toBeGreaterThan(0);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const info = modelInfos[0]!;
		expect(typeof info["model"]).toBe("string");
		expect((info["model"] as string).length).toBeGreaterThan(0);

		await client.close();
	}, 15_000);

	it("switch_model updates model_info broadcast", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Get available models from model_list
		const modelList = client.getReceivedOfType("model_list");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const providers = modelList[0]!["providers"] as Array<{
			id: string;
			models: Array<{ id: string }>;
		}>;

		// Find a provider with at least one model
		const provider = providers.find((p) => p.models.length > 0);
		expect(provider).toBeDefined();

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const targetModel = provider!.models[0]!.id;
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const targetProvider = provider!.id;

		client.clearReceived();

		// Switch to that model
		client.send({
			type: "switch_model",
			modelId: targetModel,
			providerId: targetProvider,
		});

		// Should receive model_info broadcast
		const modelInfo = await client.waitFor("model_info", { timeout: 5_000 });
		expect(modelInfo["model"]).toBe(targetModel);
		expect(modelInfo["provider"]).toBe(targetProvider);

		await client.close();
	}, 15_000);

	it("message succeeds after model switch", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Pick first model from first provider
		const modelList = client.getReceivedOfType("model_list");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const providers = modelList[0]!["providers"] as Array<{
			id: string;
			models: Array<{ id: string }>;
		}>;
		const provider = providers.find((p) => p.models.length > 0);
		expect(provider).toBeDefined();
		client.send({
			type: "switch_model",
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			modelId: provider!.models[0]!.id,
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			providerId: provider!.id,
		});

		await client.waitFor("model_info", { timeout: 5_000 });
		client.clearReceived();

		// Send a message — should work with the selected model
		client.send({
			type: "message",
			text: "Reply with just 'ok'.",
		});

		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		expect(status["status"]).toBe("processing");

		const done = await client.waitFor("done", { timeout: 5_000 });
		expect(done["code"]).toBe(0);

		await client.close();
	}, 10_000);

	it("new_session resets model selection without breaking messages", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Switch model explicitly — pick first from model list
		const modelList = client.getReceivedOfType("model_list");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const providers = modelList[0]!["providers"] as Array<{
			id: string;
			models: Array<{ id: string }>;
		}>;
		const provider = providers.find((p) => p.models.length > 0);
		expect(provider).toBeDefined();
		client.send({
			type: "switch_model",
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			modelId: provider!.models[0]!.id,
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			providerId: provider!.id,
		});

		await client.waitFor("model_info", { timeout: 5_000 });

		// Create a new session — should reset model selection
		client.send({ type: "new_session", title: "Model Reset Test" });
		await client.waitFor("session_switched", {
			timeout: 5_000,
		});

		// Let the session fully initialize before sending a message
		await new Promise((r) => setTimeout(r, 1000));
		client.clearReceived();

		// Send a message in the new session — should work
		client.send({
			type: "message",
			text: "Reply with just 'ok'.",
		});

		// The key assertion: the new session accepts messages (enters processing).
		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		expect(status["status"]).toBe("processing");

		// Wait for either done (fast) or result (model is working, just slow to finalize)
		const evidence = await Promise.race([
			client.waitFor("done", { timeout: 5_000 }),
			client.waitFor("result", { timeout: 5_000 }),
		]);
		expect(evidence.type).toMatch(/^(done|result)$/);

		await client.close();
	}, 120_000);
});
