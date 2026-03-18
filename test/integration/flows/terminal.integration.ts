// ─── Integration: Terminal (PTY) ─────────────────────────────────────────────
// Tests PTY operations against a mock OpenCode server.
// Verifies shell I/O, multi-client broadcast, multi-terminal isolation,
// resize, close/cleanup, and edge cases.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { ReceivedMessage } from "../helpers/test-ws-client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect all pty_output data for a given ptyId from received messages */
function collectOutput(messages: ReceivedMessage[], ptyId: string): string {
	return messages
		.filter((m) => m.type === "pty_output" && m["ptyId"] === ptyId)
		.map((m) => String(m["data"]))
		.join("");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Integration: Terminal (PTY)", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	// ── PTY creation ──────────────────────────────────────────────────────

	it("pty_create returns pty_created with a valid id", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "pty_create" });

		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const pty = created["pty"] as { id: string };
		expect(typeof pty.id).toBe("string");
		expect(pty.id.length).toBeGreaterThan(0);

		// Cleanup
		client.send({ type: "pty_close", ptyId: pty.id });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 15_000);

	// ── I/O round-trip ────────────────────────────────────────────────────

	it("echo command output comes back through the relay", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create PTY
		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		// Wait for shell prompt to settle
		await delay(500);
		client.clearReceived();

		// Send a command that produces known output
		client.send({
			type: "pty_input",
			ptyId,
			data: "echo INTEGRATION_TEST_MARKER\n",
		});

		// Wait for output containing our marker
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("INTEGRATION_TEST_MARKER"),
		});

		// Verify the marker appears in accumulated output
		const output = collectOutput(client.getReceived(), ptyId);
		expect(output).toContain("INTEGRATION_TEST_MARKER");

		// Cleanup
		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	it("multiple keystrokes each produce output", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(500);
		client.clearReceived();

		// Send two commands
		client.send({ type: "pty_input", ptyId, data: "echo AAA_FIRST\n" });
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId && String(msg["data"]).includes("AAA_FIRST"),
		});

		client.send({ type: "pty_input", ptyId, data: "echo BBB_SECOND\n" });
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId && String(msg["data"]).includes("BBB_SECOND"),
		});

		const output = collectOutput(client.getReceived(), ptyId);
		expect(output).toContain("AAA_FIRST");
		expect(output).toContain("BBB_SECOND");

		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 25_000);

	it("ANSI escape codes survive the round-trip", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(500);
		client.clearReceived();

		// printf outputs ANSI codes; follow with a sentinel echo so we know
		// the printf output has been fully produced before we collect
		client.send({
			type: "pty_input",
			ptyId,
			data: "printf '\\033[31mRED_TEXT\\033[0m\\n'; echo __ANSI_SENTINEL__\n",
		});

		// Wait for the sentinel's output — by the time the shell echoes/runs
		// the echo command, printf has already finished writing its output
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("__ANSI_SENTINEL__"),
		});

		// Small grace period for any trailing output to arrive
		await delay(500);

		const output = collectOutput(client.getReceived(), ptyId);
		// The output should contain the ANSI escape sequence
		expect(output).toContain("RED_TEXT");
		// Check for ESC character (0x1b) — proves ANSI codes weren't stripped
		expect(output).toContain("\x1b[");

		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	// ── Multi-client ──────────────────────────────────────────────────────

	it("two clients both receive pty_output from same PTY", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		// Client 1 creates PTY
		client1.send({ type: "pty_create" });
		const created1 = await client1.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created1["pty"] as { id: string }).id;

		// Client 2 should also get pty_created (broadcast)
		await client2.waitFor("pty_created", { timeout: 5_000 });

		await delay(500);
		client1.clearReceived();
		client2.clearReceived();

		// Client 1 sends input
		client1.send({
			type: "pty_input",
			ptyId,
			data: "echo MULTI_CLIENT_TEST\n",
		});

		// Both clients should receive the output
		await client1.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("MULTI_CLIENT_TEST"),
		});
		await client2.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("MULTI_CLIENT_TEST"),
		});

		client1.send({ type: "pty_close", ptyId });
		await client1.waitFor("pty_deleted", { timeout: 5_000 });
		await client1.close();
		await client2.close();
	}, 25_000);

	it("client B can send input to PTY that client A created", async () => {
		const clientA = await harness.connectWsClient();
		const clientB = await harness.connectWsClient();
		await clientA.waitForInitialState();
		await clientB.waitForInitialState();
		clientA.clearReceived();
		clientB.clearReceived();

		// Client A creates PTY
		clientA.send({ type: "pty_create" });
		const created = await clientA.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(500);
		clientA.clearReceived();
		clientB.clearReceived();

		// Client B sends input
		clientB.send({
			type: "pty_input",
			ptyId,
			data: "echo CROSS_CLIENT_INPUT\n",
		});

		// Client A should receive the output
		await clientA.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("CROSS_CLIENT_INPUT"),
		});

		clientA.send({ type: "pty_close", ptyId });
		await clientA.waitFor("pty_deleted", { timeout: 5_000 });
		await clientA.close();
		await clientB.close();
	}, 25_000);

	it("client disconnect does NOT close the upstream PTY", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();
		client1.clearReceived();

		// Create PTY
		client1.send({ type: "pty_create" });
		const created = await client1.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		// Disconnect client 1
		await client1.close();

		// Connect a new client — the PTY should still be alive
		const client2 = await harness.connectWsClient();
		await client2.waitForInitialState();
		client2.clearReceived();

		// Send input to the existing PTY
		client2.send({ type: "pty_input", ptyId, data: "echo STILL_ALIVE\n" });

		// Should get output back
		await client2.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId && String(msg["data"]).includes("STILL_ALIVE"),
		});

		client2.send({ type: "pty_close", ptyId });
		await client2.waitFor("pty_deleted", { timeout: 5_000 });
		await client2.close();
	}, 25_000);

	// ── Multi-terminal ────────────────────────────────────────────────────

	it("two PTYs have independent I/O", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create two PTYs
		client.send({ type: "pty_create" });
		const created1 = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId1 = (created1["pty"] as { id: string }).id;

		client.send({ type: "pty_create" });
		const created2 = await client.waitFor("pty_created", {
			timeout: 10_000,
			predicate: (msg) => (msg["pty"] as { id: string }).id !== ptyId1,
		});
		const ptyId2 = (created2["pty"] as { id: string }).id;

		await delay(500);
		client.clearReceived();

		// Send unique markers to each PTY
		client.send({
			type: "pty_input",
			ptyId: ptyId1,
			data: "echo PTY_ONE_ONLY\n",
		});
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId1 && String(msg["data"]).includes("PTY_ONE_ONLY"),
		});

		client.send({
			type: "pty_input",
			ptyId: ptyId2,
			data: "echo PTY_TWO_ONLY\n",
		});
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId2 && String(msg["data"]).includes("PTY_TWO_ONLY"),
		});

		// Verify isolation: PTY1 output does NOT contain PTY2's marker
		const output1 = collectOutput(client.getReceived(), ptyId1);
		const output2 = collectOutput(client.getReceived(), ptyId2);
		expect(output1).not.toContain("PTY_TWO_ONLY");
		expect(output2).not.toContain("PTY_ONE_ONLY");

		// Cleanup both
		client.send({ type: "pty_close", ptyId: ptyId1 });
		await client.waitFor("pty_deleted", {
			timeout: 5_000,
			predicate: (msg) => msg["ptyId"] === ptyId1,
		});
		client.send({ type: "pty_close", ptyId: ptyId2 });
		await client.waitFor("pty_deleted", {
			timeout: 5_000,
			predicate: (msg) => msg["ptyId"] === ptyId2,
		});
		await client.close();
	}, 30_000);

	it("closing one PTY does not affect the other", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create two PTYs
		client.send({ type: "pty_create" });
		const created1 = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId1 = (created1["pty"] as { id: string }).id;

		client.send({ type: "pty_create" });
		const created2 = await client.waitFor("pty_created", {
			timeout: 10_000,
			predicate: (msg) => (msg["pty"] as { id: string }).id !== ptyId1,
		});
		const ptyId2 = (created2["pty"] as { id: string }).id;

		await delay(500);

		// Close PTY 1
		client.send({ type: "pty_close", ptyId: ptyId1 });
		await client.waitFor("pty_deleted", {
			timeout: 5_000,
			predicate: (msg) => msg["ptyId"] === ptyId1,
		});

		client.clearReceived();

		// PTY 2 should still work
		client.send({ type: "pty_input", ptyId: ptyId2, data: "echo SURVIVOR\n" });
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId2 && String(msg["data"]).includes("SURVIVOR"),
		});

		client.send({ type: "pty_close", ptyId: ptyId2 });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 25_000);

	// ── Resize ────────────────────────────────────────────────────────────

	it("pty_resize changes terminal dimensions", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(500);

		// Resize to known dimensions
		client.send({ type: "pty_resize", ptyId, cols: 120, rows: 40 });
		await delay(500);
		client.clearReceived();

		// Query the terminal size via tput (works on most shells)
		client.send({ type: "pty_input", ptyId, data: "tput cols\n" });

		// Wait for output — should contain "120"
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId && String(msg["data"]).includes("120"),
		});

		// No errors
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);

		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	// ── Close + cleanup ───────────────────────────────────────────────────

	it("pty_close returns pty_deleted with correct id", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		client.send({ type: "pty_close", ptyId });
		const deleted = await client.waitFor("pty_deleted", { timeout: 5_000 });
		expect(deleted["ptyId"]).toBe(ptyId);

		await client.close();
	}, 15_000);

	it("full lifecycle: create → input → verify output → resize → close", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create
		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(500);
		client.clearReceived();

		// Input → verify output
		client.send({ type: "pty_input", ptyId, data: "echo LIFECYCLE_TEST\n" });
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === ptyId &&
				String(msg["data"]).includes("LIFECYCLE_TEST"),
		});

		// Resize
		client.send({ type: "pty_resize", ptyId, cols: 100, rows: 30 });
		await delay(300);

		// Close
		client.send({ type: "pty_close", ptyId });
		const deleted = await client.waitFor("pty_deleted", { timeout: 5_000 });
		expect(deleted["ptyId"]).toBe(ptyId);

		// No errors
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);

		await client.close();
	}, 25_000);

	// ── Edge cases ────────────────────────────────────────────────────────

	it("pty_input to nonexistent PTY ID does not crash", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send input to a fake PTY ID
		client.send({
			type: "pty_input",
			ptyId: "nonexistent-pty-id",
			data: "hello\n",
		});

		// Wait a moment — should not produce an error
		await delay(1000);
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);

		await client.close();
	}, 10_000);

	it("pty_input after close does not crash", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create and close a PTY
		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		client.clearReceived();

		// Send input to the closed PTY
		client.send({ type: "pty_input", ptyId, data: "should not crash\n" });

		// Wait a moment — should not produce an error or crash
		await delay(1000);

		// The relay should still be responsive
		client.send({ type: "pty_create" });
		const created2 = await client.waitFor("pty_created", { timeout: 10_000 });
		expect(created2["pty"]).toBeDefined();

		const ptyId2 = (created2["pty"] as { id: string }).id;
		client.send({ type: "pty_close", ptyId: ptyId2 });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	// ── Terminal panel open with new tab ──────────────────────────────────

	it("opening the terminal panel creates at least one new tab that starts successfully", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Simulate what the frontend does when user clicks the terminal button
		// with no existing tabs: sends pty_create (via togglePanel with auto-create)
		client.send({ type: "pty_create" });

		// Should receive pty_created with a valid PTY
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const pty = created["pty"] as { id: string; status?: string };
		expect(pty).toBeDefined();
		expect(typeof pty.id).toBe("string");
		expect(pty.id.length).toBeGreaterThan(0);

		// The PTY should be running and produce output (shell prompt)
		await delay(500);

		// Send a simple command to verify the PTY is interactive
		client.send({
			type: "pty_input",
			ptyId: pty.id,
			data: "echo PANEL_OPEN_TEST\n",
		});

		// Should receive output containing our marker
		await client.waitFor("pty_output", {
			timeout: 10_000,
			predicate: (msg) =>
				msg["ptyId"] === pty.id &&
				String(msg["data"]).includes("PANEL_OPEN_TEST"),
		});

		// Verify the output round-trip worked
		const output = collectOutput(client.getReceived(), pty.id);
		expect(output).toContain("PANEL_OPEN_TEST");

		// Cleanup
		client.send({ type: "pty_close", ptyId: pty.id });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	// ── PTY list on connect ──────────────────────────────────────────────

	it("terminal_command list returns existing PTYs after creation", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a PTY
		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		await delay(300);
		client.clearReceived();

		// Request PTY list
		client.send({ type: "terminal_command", action: "list" });

		// Should receive pty_list with at least the PTY we created
		const list = await client.waitFor("pty_list", { timeout: 5_000 });
		const ptys = list["ptys"] as Array<{ id: string }>;
		expect(Array.isArray(ptys)).toBe(true);
		expect(ptys.length).toBeGreaterThanOrEqual(1);

		const found = ptys.find((p) => p.id === ptyId);
		expect(found).toBeTruthy();

		// Cleanup
		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 20_000);

	// ── No strange characters in output ──────────────────────────────────

	it("new PTY output does not contain cursor metadata characters", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a PTY
		client.send({ type: "pty_create" });
		const created = await client.waitFor("pty_created", { timeout: 10_000 });
		const ptyId = (created["pty"] as { id: string }).id;

		// Wait for initial shell output
		await delay(1000);

		// Collect all output received so far
		const output = collectOutput(client.getReceived(), ptyId);

		// Output should NOT contain null bytes (0x00) which are cursor metadata
		for (let i = 0; i < output.length; i++) {
			expect(output.charCodeAt(i)).not.toBe(0);
		}

		// Output should not start with JSON-like cursor metadata
		if (output.length > 0) {
			// Check that it doesn't look like raw cursor metadata: {"cursor":N}
			expect(output).not.toMatch(/^\{"cursor":\d+\}/);
		}

		// Cleanup
		client.send({ type: "pty_close", ptyId });
		await client.waitFor("pty_deleted", { timeout: 5_000 });
		await client.close();
	}, 15_000);
});
