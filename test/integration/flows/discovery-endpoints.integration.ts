// ─── Integration: Discovery Endpoints Data Quality ──────────────────────────
// Verifies that the data returned by discovery endpoints (agents, models,
// commands, sessions, files) contains the expected fields and shapes.
// Goes beyond "does it respond" to validate the actual data quality.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Discovery Endpoints Data Quality", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("agents have required fields", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });

		const agents = msg["agents"] as Array<{
			id: string;
			name: string;
			description?: string;
		}>;
		expect(Array.isArray(agents)).toBe(true);
		expect(agents.length).toBeGreaterThan(0);

		for (const agent of agents) {
			expect(agent.id).toBeTruthy();
			expect(typeof agent.id).toBe("string");
			expect(agent.name).toBeTruthy();
			expect(typeof agent.name).toBe("string");
			// description is optional but if present should be a string
			if (agent.description !== undefined) {
				expect(typeof agent.description).toBe("string");
			}
		}

		await client.close();
	});

	it("providers have models", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_models" });
		const msg = await client.waitFor("model_list", { timeout: 5000 });

		const providers = msg["providers"] as Array<{
			id: string;
			name: string;
			models: Array<{ id: string; name: string; provider: string }>;
		}>;
		expect(Array.isArray(providers)).toBe(true);
		expect(providers.length).toBeGreaterThan(0);

		// Each provider should have id, name, and models array
		for (const provider of providers) {
			expect(provider.id).toBeTruthy();
			expect(typeof provider.id).toBe("string");
			expect(provider.name).toBeTruthy();
			expect(typeof provider.name).toBe("string");
			expect(Array.isArray(provider.models)).toBe(true);
		}

		// At least one provider should have models
		const withModels = providers.filter((p) => p.models.length > 0);
		expect(withModels.length).toBeGreaterThan(0);

		// Verify model shape for providers that have them
		for (const provider of withModels) {
			for (const model of provider.models) {
				expect(model.id).toBeTruthy();
				expect(typeof model.id).toBe("string");
				expect(model.name).toBeTruthy();
				expect(typeof model.name).toBe("string");
				expect(typeof model.provider).toBe("string");
			}
		}

		await client.close();
	});

	it("commands have name and description", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_commands" });
		const msg = await client.waitFor("command_list", { timeout: 5000 });

		const commands = msg["commands"] as Array<{
			name: string;
			description?: string;
		}>;
		expect(Array.isArray(commands)).toBe(true);

		// Each command should have a name
		for (const command of commands) {
			expect(command.name).toBeTruthy();
			expect(typeof command.name).toBe("string");
		}

		await client.close();
	});

	it("session list entries have id and title", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "list_sessions" });
		const msg = await client.waitFor("session_list", { timeout: 5000 });

		const sessions = msg["sessions"] as Array<{ id: string; title: string }>;
		expect(Array.isArray(sessions)).toBe(true);
		expect(sessions.length).toBeGreaterThan(0);

		for (const session of sessions) {
			expect(session.id).toBeTruthy();
			expect(typeof session.id).toBe("string");
			expect(typeof session.title).toBe("string");
		}

		await client.close();
	});

	it("file list contains expected project files", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_file_list", path: "." });
		const msg = await client.waitFor("file_list", { timeout: 5000 });

		expect(msg["path"]).toBe(".");
		const entries = msg["entries"] as Array<{
			name: string;
			type: "file" | "directory";
		}>;
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);

		// Should contain common project files
		const names = entries.map((e) => e.name);
		expect(names).toContain("package.json");
		expect(names).toContain("src");

		// Verify entry shapes
		for (const entry of entries) {
			expect(entry.name).toBeTruthy();
			expect(typeof entry.name).toBe("string");
			expect(["file", "directory"]).toContain(entry.type);
		}

		await client.close();
	});

	it("model_info is sent when session has a configured model", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// get_models also sends model_info for the active session IF it has a modelID
		client.send({ type: "get_models" });
		await client.waitFor("model_list", { timeout: 5000 });

		// model_info may or may not arrive depending on whether the active session
		// has a modelID configured. If it does arrive, verify its shape.
		await new Promise((r) => setTimeout(r, 500));
		const modelInfos = client.getReceivedOfType("model_info");
		if (modelInfos.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const modelInfo = modelInfos[0]!;
			expect(typeof modelInfo["model"]).toBe("string");
			expect(typeof modelInfo["provider"]).toBe("string");
		}
		// If no model_info, that's fine — the session just doesn't have a model set

		await client.close();
	});
});
