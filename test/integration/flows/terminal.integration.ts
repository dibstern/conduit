// Integration: Terminal (PTY)
// Tests PTY operations against a mock OpenCode server.
// Terminals stream over SubscribePtys and take input over the PtyInput RPC.
// Verifies shell I/O, multi-client broadcast, close/cleanup, and edge cases.

import { mkdirSync, writeFileSync } from "node:fs";
import { Context, Effect, Option, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenCodePtySchema } from "../../../src/lib/contracts/providers/opencode-sdk.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { PtyManagerTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	isPtyEvent,
	type PtyEvent,
} from "../../../src/lib/relay/opencode-events.js";
import type { PtyInfo } from "../../../src/lib/shared-types.js";
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

function waitForPty(
	client: TestWsClient,
	id: string,
	status: PtyInfo["status"],
	title: string,
) {
	return client.waitFor("pty", {
		predicate: (message) =>
			message["_tag"] === "upsert" &&
			(message["item"] as PtyInfo).id === id &&
			(message["item"] as PtyInfo).status === status &&
			(message["item"] as PtyInfo).title === title,
	});
}

async function createExternalPty(harness: RelayHarness) {
	return Schema.decodeUnknownSync(OpenCodePtySchema)(
		await harness.stack.client.pty.create(),
	);
}

function signalDelivered(
	harness: RelayHarness,
	id: string,
	type: PtyEvent["type"] = "pty.created",
) {
	let delivered = 0;
	harness.stack.sseStream.on("event", (event) => {
		if (
			isPtyEvent(event) &&
			event.type === type &&
			(event.type === "pty.created" || event.type === "pty.updated"
				? event.properties.info?.id
				: event.properties.id) === id
		)
			delivered++;
	});
	return () => delivered;
}

function signal(harness: RelayHarness, type: PtyEvent["type"], pty: PtyInfo) {
	harness.mock.injectSSEEvents([
		{
			type,
			properties:
				type === "pty.created" || type === "pty.updated"
					? { info: { args: [], ...pty } }
					: type === "pty.exited"
						? { id: pty.id, exitCode: 0 }
						: { id: pty.id },
		},
	]);
}

const listCount = (harness: RelayHarness) =>
	harness.mock.diagnostics.filter(({ event }) => event === "pty_list").length;

async function relayServices(harness: RelayHarness) {
	const context = harness.stack.rpcWsHandler.context;
	if (!context) throw new Error("Relay RPC context is unavailable");
	const services = await Effect.runPromise(context);
	return {
		manager: Option.getOrThrow(Context.getOption(services, PtyManagerTag)),
		instances: Option.getOrThrow(
			Context.getOption(services, OpenCodeInstancesTag),
		),
	};
}

describe("Integration: Terminal (PTY)", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("cancelled SubscribePtys cannot attach a phantom after an empty reconcile", async () => {
		const isolated = await createRelayHarness();
		const { manager, instances } = await relayServices(isolated);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const acquire = instances.useIfRunning;
		const attaching = vi.fn();
		const registrations = vi.spyOn(manager, "registerSession");
		// Discovery attaches as soon as the PTY appears, before any subscriber
		// asks, so hold the first attachment lease whoever requested it.
		const lease = vi.spyOn(instances, "useIfRunning").mockImplementation((id) =>
			Effect.suspend(() => {
				const unattached = manager.listSessions().some(({ id: ptyId }) => {
					const session = manager.getSession(ptyId);
					return session?.source === "opencode" && !session.upstream;
				});
				if (!unattached || attaching.mock.calls.length > 0) return acquire(id);
				attaching();
				return Effect.promise(() => held).pipe(Effect.zipRight(acquire(id)));
			}),
		);
		const pty = await createExternalPty(isolated);
		const first = await isolated.connectWsClient();
		const second = await isolated.connectWsClient();
		await Promise.all([
			first.waitForInitialState(),
			second.waitForInitialState(),
		]);
		const pending = first.subscribePtys().catch(() => undefined);
		try {
			await expect.poll(() => attaching.mock.calls.length).toBe(1);
			await first.close();
			await isolated.stack.client.pty.delete(pty.id);
			const next = second.listPtys();
			// The old caller-owned path completes this empty read while its
			// detached attachment is pending. The worker instead waits for it.
			await Promise.race([
				next,
				new Promise((resolve) => setTimeout(resolve, 100)),
			]);
			release();
			expect((await next).ptys).toEqual([]);
			await expect
				.poll(
					() =>
						registrations.mock.calls.filter(
							([id, upstream]) => id === pty.id && upstream !== undefined,
						).length,
				)
				.toBe(1);
			expect(manager.hasSession(pty.id)).toBe(false);
		} finally {
			release();
			lease.mockRestore();
			registrations.mockRestore();
			await pending;
			await Promise.all([first.close(), second.close()]);
			await isolated.stop();
		}
	}, 20_000);

	it("retries a failed authoritative discovery without another signal or subscription", async () => {
		const client = await connect(harness);
		const pty = await createExternalPty(harness);
		const before = listCount(harness);
		try {
			harness.mock.ptyListFailures = 1;
			signal(harness, "pty.created", pty);
			await waitForPty(client, pty.id, "running", pty.title);
			expect(listCount(harness) - before).toBe(2);
		} finally {
			harness.mock.ptyListFailures = 0;
			await client.closePty(pty.id);
			await client.close();
		}
	}, 15_000);

	it("reconciles missed PTY changes when the SSE stream reconnects", async () => {
		const client = await connect(harness);
		const removed = await createExternalPty(harness);
		let added: PtyInfo | undefined;
		try {
			signal(harness, "pty.created", removed);
			await waitForPty(client, removed.id, "running", removed.title);
			await waitForOutput(client, removed.id, "$ ");
			// Silent inventory changes model missed SSE events. Complete them
			// before reconnect so its snapshot cannot precede the new PTY.
			await harness.stack.client.pty.delete(removed.id);
			added = await createExternalPty(harness);
			harness.mock.disconnectSseClients();
			await waitForRemoved(client, removed.id);
			await waitForPty(client, added.id, "running", added.title);
		} finally {
			await harness.stack.client.pty.delete(removed.id);
			if (added) await client.closePty(added.id);
			await client.close();
		}
	}, 15_000);

	it("reconciles external lifecycle signals from provider state without resubscribing", async () => {
		const client = await connect(harness);
		const pty = await createExternalPty(harness);
		try {
			const info = { ...pty, title: "External shell" };
			harness.mock.setPtyInfo(info);
			// Deliberately stale payload: only GET /pty is authoritative.
			signal(harness, "pty.created", pty);
			await waitForPty(client, info.id, "running", info.title);
			await waitForOutput(client, info.id, "$ ");
			await client.ptyInput(info.id, "EXTERNAL_PTY_OUTPUT\n");
			await waitForOutput(client, info.id, "EXTERNAL_PTY_OUTPUT");

			let release!: () => void;
			harness.mock.holdPtyListsUntil(
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			);
			const listsBefore = listCount(harness);
			signal(harness, "pty.created", pty);
			try {
				await expect.poll(() => listCount(harness)).toBe(listsBefore + 1);
				const delivered = signalDelivered(harness, info.id, "pty.updated");
				harness.mock.setPtyInfo({ ...info, title: "Renamed shell" });
				harness.mock.injectSSEEvents(
					Array.from({ length: 20 }, () => ({
						type: "pty.updated",
						properties: { info: pty },
					})),
				);
				await expect.poll(delivered).toBe(20);
			} finally {
				release();
			}
			const updated = { ...info, title: "Renamed shell" };
			await waitForPty(client, info.id, "running", updated.title);
			expect(listCount(harness) - listsBefore).toBe(2);
			expect(
				client
					.getReceivedOfType("pty")
					.filter(
						(m) =>
							m["_tag"] === "upsert" &&
							(m["item"] as PtyInfo).title === updated.title,
					),
			).toHaveLength(1);

			const { manager } = await relayServices(harness);
			const scrollback = manager.getScrollback(info.id);
			harness.mock.rejectedPtyConnections.add(info.id);
			manager.getSession(info.id)?.upstream?.terminate();
			await waitForPty(client, info.id, "exited", updated.title);
			signal(harness, "pty.updated", pty);
			await expect
				.poll(() => manager.getSession(info.id)?.upstream)
				.toBeUndefined();
			expect(manager.getScrollback(info.id)).toBe(scrollback);
			harness.mock.rejectedPtyConnections.delete(info.id);

			harness.mock.setPtyInfo({
				...updated,
				title: "Exited shell",
				status: "exited",
			});
			signal(harness, "pty.exited", pty);
			await waitForPty(client, info.id, "exited", "Exited shell");
			await harness.stack.client.pty.delete(info.id);
			signal(harness, "pty.deleted", pty);
			await waitForRemoved(client, info.id);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ni8-47-pty-lifecycle.json",
				JSON.stringify(client.getReceivedOfType("pty"), null, 2),
			);
		} finally {
			harness.mock.rejectedPtyConnections.delete(pty.id);
			await harness.stack.client.pty.delete(pty.id);
			await client.close();
		}
	}, 20_000);

	it("corrects a missed delete and ignores a late created signal using the next snapshot", async () => {
		const client = await connect(harness);
		const deleted = await createExternalPty(harness);
		const survivor = await createExternalPty(harness);
		try {
			signal(harness, "pty.created", deleted);
			await waitForPty(client, deleted.id, "running", deleted.title);
			await harness.stack.client.pty.delete(deleted.id); // No deleted SSE.
			signal(harness, "pty.updated", survivor);
			signal(harness, "pty.created", deleted);
			await waitForRemoved(client, deleted.id);
			await waitForPty(client, survivor.id, "running", survivor.title);
			expect((await client.listPtys()).ptys.map(({ id }) => id)).not.toContain(
				deleted.id,
			);
		} finally {
			await harness.stack.client.pty.delete(deleted.id);
			await client.closePty(survivor.id);
			await client.close();
		}
	}, 15_000);

	it("restores a hosted local PTY ahead of a colliding provider row and leaves it untouched", async () => {
		const client = await connect(harness);
		await client.createPty();
		const id = await waitForCreated(client);
		const { manager } = await relayServices(harness);
		const local = (await client.listPtys()).ptys.find((pty) => pty.id === id);
		expect(local).toBeDefined();
		if (!local) throw new Error("Missing local terminal");
		try {
			// The PTY host survives detaching the relay proxy. Reproduce a provider
			// discovery racing restoration by installing the colliding cache row.
			manager.detachAll();
			const collision = {
				...local,
				title: "Provider collision",
				status: "exited" as const,
				args: [],
			};
			manager.registerSession(id, undefined, "opencode", collision);
			harness.mock.setPtyInfo(collision);
			client.clearReceived();
			signal(harness, "pty.created", collision);
			await waitForPty(client, id, "running", local.title);
			const restored = manager.getSession(id);
			expect(restored?.source).toBe("local");
			await harness.stack.client.pty.delete(id);
			for (const type of ["pty.updated", "pty.exited", "pty.deleted"] as const)
				signal(harness, type, collision);
			await client.ptyInput(id, "echo LOCAL_COLLISION_SURVIVED\n");
			await waitForOutput(client, id, "LOCAL_COLLISION_SURVIVED");
			expect(manager.getSession(id)).toBe(restored);
			expect(
				(await client.listPtys()).ptys.find((pty) => pty.id === id),
			).toEqual(local);
		} finally {
			await harness.stack.client.pty.delete(id);
			await client.closePty(id);
			await client.close();
		}
	}, 20_000);

	it("does not attach after relay stop while provider acquisition is pending", async () => {
		const isolated = await createRelayHarness();
		const client = await connect(isolated);
		const { manager, instances } = await relayServices(isolated);
		const pty = await createExternalPty(isolated);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const acquiring = vi.fn();
		const acquire = instances.useIfRunning;
		const useIfRunning = vi
			.spyOn(instances, "useIfRunning")
			.mockImplementation((id) =>
				Effect.suspend(() => {
					const session = manager.getSession(pty.id);
					if (session?.source !== "opencode" || session.upstream)
						return acquire(id);
					acquiring();
					return Effect.promise(() => held).pipe(Effect.zipRight(acquire(id)));
				}),
			);
		const delivered = signalDelivered(isolated, pty.id);
		try {
			signal(isolated, "pty.created", pty);
			await expect.poll(delivered).toBe(1);
			await expect.poll(() => acquiring.mock.calls.length).toBeGreaterThan(0);
			await isolated.stack.stop();
			release();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(
				isolated.mock.diagnostics.filter(
					({ event }) => event === "pty_connect",
				),
			).toHaveLength(0);
			expect(manager.hasSession(pty.id)).toBe(false);
		} finally {
			release();
			useIfRunning.mockRestore();
			await client.close();
			await isolated.stop();
		}
	}, 20_000);

	it("does not start a stopped instance in response to a lifecycle signal", async () => {
		const client = await connect(harness);
		const { manager, instances } = await relayServices(harness);
		const pty = await createExternalPty(harness);
		const cached = await createExternalPty(harness);
		manager.registerSession(cached.id, undefined, "opencode", cached);
		// Model the stopped-instance acquisition boundary while retaining SSE
		// delivery, so a queued event from before stop still reaches the relay.
		const lease = vi
			.spyOn(instances, "useIfRunning")
			.mockReturnValue(Effect.succeed(Option.none()));
		const use = vi.spyOn(instances, "use");
		const delivered = signalDelivered(harness, pty.id);
		const deleted = signalDelivered(harness, cached.id, "pty.deleted");
		const listsBefore = listCount(harness);
		try {
			signal(harness, "pty.created", pty);
			signal(harness, "pty.deleted", cached);
			await expect.poll(delivered).toBe(1);
			await expect.poll(deleted).toBe(1);
			await expect.poll(() => lease.mock.calls.length).toBeGreaterThan(0);
			expect(use).not.toHaveBeenCalled();
			expect(manager.hasSession(pty.id)).toBe(false);
			expect(manager.getSession(cached.id)?.info).toEqual(cached);
			expect(listCount(harness)).toBe(listsBefore);
		} finally {
			use.mockRestore();
			lease.mockRestore();
			await harness.stack.client.pty.delete(pty.id);
			await harness.stack.client.pty.delete(cached.id);
			manager.closeSession(cached.id);
			await client.close();
		}
	}, 15_000);

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
