// Integration: Terminal (PTY)
// Tests PTY operations against a mock OpenCode server.
// Terminals stream over SubscribePtys and take input over the PtyInput RPC.
// Verifies shell I/O, multi-client broadcast, close/cleanup, and edge cases.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type {
	ReceivedMessage,
	TestWsClient,
} from "../helpers/test-ws-client.js";

/** All output a client's PTY subscription delivered for one terminal. */
function collectOutput(messages: ReceivedMessage[], ptyId: string): string {
	return messages
		.filter((m) => m["_tag"] === "output" && m["ptyId"] === ptyId)
		.map((m) => String(m["data"]))
		.join("");
}

/** Wait for the subscription to announce a PTY; returns its id. */
async function waitForCreated(client: TestWsClient): Promise<string> {
	const created = await client.waitFor("pty", {
		timeout: 5_000,
		predicate: (m) => m["_tag"] === "upsert",
	});
	return (created["item"] as { id: string }).id;
}

function waitForRemoved(client: TestWsClient, ptyId: string) {
	return client.waitFor("pty", {
		timeout: 5_000,
		predicate: (m) => m["_tag"] === "remove" && m["id"] === ptyId,
	});
}

function waitForOutput(client: TestWsClient, ptyId: string, text: string) {
	return client.waitFor("pty", {
		timeout: 5_000,
		predicate: (m) =>
			m["_tag"] === "output" &&
			m["ptyId"] === ptyId &&
			String(m["data"]).includes(text),
	});
}

async function connect(harness: RelayHarness): Promise<TestWsClient> {
	const client = await harness.connectWsClient();
	await client.waitForInitialState();
	await client.subscribePtys();
	client.clearReceived();
	return client;
}

describe("Integration: Terminal (PTY)", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("CreatePty announces the PTY with a valid id", async () => {
		const client = await connect(harness);

		await client.createPty();
		const ptyId = await waitForCreated(client);
		expect(ptyId.length).toBeGreaterThan(0);

		await client.closePty(ptyId);
		await waitForRemoved(client, ptyId);
		await client.close();
	}, 15_000);

	it("two clients both receive output from same PTY", async () => {
		const client1 = await connect(harness);
		const client2 = await connect(harness);

		await client1.createPty();
		const ptyId = await waitForCreated(client1);
		// Client 2 sees the same terminal on its own subscription.
		expect(await waitForCreated(client2)).toBe(ptyId);

		await client1.ptyInput(ptyId, "echo MULTI_CLIENT_TEST\n");

		await waitForOutput(client1, ptyId, "MULTI_CLIENT_TEST");
		await waitForOutput(client2, ptyId, "MULTI_CLIENT_TEST");

		await client1.closePty(ptyId);
		await waitForRemoved(client1, ptyId);
		await client1.close();
		await client2.close();
	}, 25_000);

	it("client B can send input to PTY that client A created", async () => {
		const clientA = await connect(harness);
		const clientB = await connect(harness);

		await clientA.createPty();
		const ptyId = await waitForCreated(clientA);

		await clientB.ptyInput(ptyId, "echo CROSS_CLIENT_INPUT\n");

		await waitForOutput(clientA, ptyId, "CROSS_CLIENT_INPUT");

		await clientA.closePty(ptyId);
		await waitForRemoved(clientA, ptyId);
		await clientA.close();
		await clientB.close();
	}, 25_000);

	it("client disconnect does NOT close the upstream PTY", async () => {
		const client1 = await connect(harness);
		await client1.createPty();
		const ptyId = await waitForCreated(client1);
		await client1.close();

		// A new client's opening snapshot still lists the PTY.
		const client2 = await harness.connectWsClient();
		await client2.waitForInitialState();
		await client2.subscribePtys();
		const snapshot = await client2.waitFor("pty", {
			predicate: (m) => m["_tag"] === "snapshot",
		});
		expect(
			(snapshot["rows"] as Array<{ pty: { id: string } }>).map(
				({ pty }) => pty.id,
			),
		).toContain(ptyId);

		await client2.ptyInput(ptyId, "echo STILL_ALIVE\n");
		await waitForOutput(client2, ptyId, "STILL_ALIVE");

		await client2.closePty(ptyId);
		await waitForRemoved(client2, ptyId);
		await client2.close();
	}, 25_000);

	it("PtyInput to nonexistent PTY ID fails as a typed error", async () => {
		const client = await connect(harness);

		await expect(
			client.ptyInput("nonexistent-pty-id", "hello\n"),
		).rejects.toThrow("Terminal is unavailable");
		expect(client.getReceivedOfType("error")).toHaveLength(0);

		await client.close();
	}, 10_000);

	it("PtyInput after close fails and the relay stays responsive", async () => {
		const client = await connect(harness);

		await client.createPty();
		const ptyId = await waitForCreated(client);
		await client.closePty(ptyId);
		await waitForRemoved(client, ptyId);
		client.clearReceived();

		await expect(client.ptyInput(ptyId, "should not crash\n")).rejects.toThrow(
			"Terminal is unavailable",
		);

		await client.createPty();
		const ptyId2 = await waitForCreated(client);
		await client.closePty(ptyId2);
		await waitForRemoved(client, ptyId2);
		await client.close();
	}, 20_000);

	it("ListPtys RPC returns existing PTYs after creation", async () => {
		const client = await connect(harness);

		await client.createPty();
		const ptyId = await waitForCreated(client);

		const { ptys } = await client.listPtys();
		expect(ptys.find((p) => p.id === ptyId)).toBeTruthy();

		await client.closePty(ptyId);
		await waitForRemoved(client, ptyId);
		await client.close();
	}, 20_000);

	it("new PTY output does not contain cursor metadata characters", async () => {
		const client = await connect(harness);

		await client.createPty();
		const ptyId = await waitForCreated(client);

		// Wait for the shell's first output before checking its framing.
		await client.waitFor("pty", {
			timeout: 5_000,
			predicate: (m) => m["_tag"] === "output" && m["ptyId"] === ptyId,
		});

		const output = collectOutput(client.getReceived(), ptyId);
		// No null bytes (0x00), which are cursor metadata.
		for (let i = 0; i < output.length; i++) {
			expect(output.charCodeAt(i)).not.toBe(0);
		}
		// Not raw cursor metadata: {"cursor":N}
		if (output.length > 0) expect(output).not.toMatch(/^\{"cursor":\d+\}/);

		await client.closePty(ptyId);
		await waitForRemoved(client, ptyId);
		await client.close();
	}, 15_000);
});
