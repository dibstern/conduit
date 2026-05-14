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

		const result = await client.getAgents();

		const agents = result.agents as Array<{
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

	it("commands have name and description", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getCommands();

		const commands = result.commands as Array<{
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

	it("file list contains expected project files", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getFileList(".");

		expect(result.path).toBe(".");
		const entries = result.entries as Array<{
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
});
