// conduit-test-ni8.56: fan-out can fail if a writer never reaches the daemon
// bus, the daemon misses a live relay, or the receiver only notifies subscribers
// and leaves its defaults stale. A write during relay startup can be missed
// between loading settings and entering the live cache. Queued writes from
// both projects can roll the latest writer back if a receiver applies a stale
// payload, or an older sync publishes after a newer sync. Delivery can also
// miss a session preference that changes the default variant, echo, write disk
// again, or leak per-project live facts to other projects.
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { RpcMessage } from "@effect/rpc";
import { Effect, Fiber, Stream } from "effect";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import {
	type ProjectSetting,
	type ProjectSettingsEnvelope,
	SetDefaultPermissionMode,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

it("fans global settings out to another live project's subscribers and defaults", async () => {
	const harness = ProcessHarness.create({
		dist: "dist",
		foregroundCli: true,
		capabilityModels: [
			{
				id: "opus",
				name: "Fixture Opus",
				providerId: "claude",
				variants: { high: {} },
			},
		],
	});
	const receivedA: ProjectSettingsEnvelope[] = [];
	const receivedB: ProjectSettingsEnvelope[] = [];
	const subscribers: Fiber.RuntimeFiber<void, unknown>[] = [];
	const startupGate = join(harness.root, "capabilities-probe-gated");
	let snapshotB: ProjectSettingsEnvelope | undefined;
	let variantSnapshotB: ProjectSettingsEnvelope | undefined;
	let concurrentModes: (string | undefined)[] = [];
	const replies: RpcMessage.FromServerEncoded[] = [];
	let batchedRpc: WebSocket | undefined;
	let passed = false;
	try {
		await harness.restart();
		const projectA = "process-test";
		saveRelaySettings(
			{ defaultVariants: { "claude/opus": "high" } },
			harness.configDir,
		);
		const browserA = await harness.connect();
		const dirB = join(harness.root, "project-b");
		mkdirSync(dirB);
		const { savedSlug: projectB } = await Effect.runPromise(
			browserA.rpc.SaveProject({ folders: [dirB] }),
		);
		writeFileSync(startupGate, "hold");
		const connectingB = harness.connect(undefined, undefined, projectB);
		await expect.poll(() => existsSync(`${startupGate}-started`)).toBe(true);
		await Effect.runPromise(
			browserA.rpc.SetDefaultPermissionMode({
				projectSlug: projectA,
				mode: "auto",
			}),
		);
		writeFileSync(`${startupGate}-release`, "release");
		const browserB = await connectingB;
		for (const [browser, slug, received] of [
			[browserA, projectA, receivedA],
			[browserB, projectB, receivedB],
		] as const) {
			subscribers.push(
				Effect.runFork(
					Stream.runForEach(
						browser.rpc.SubscribeProjectSettings({ projectSlug: slug }),
						(envelope) => Effect.sync(() => received.push(envelope)),
					),
				),
			);
			await expect
				.poll(() => received.some((item) => item._tag === "synchronized"))
				.toBe(true);
		}
		const initialB = receivedB[0];
		expect(initialB?._tag === "snapshot" && initialB.rows).toContainEqual({
			_tag: "defaultPermissionMode",
			mode: "auto",
		});

		await Effect.runPromise(
			browserA.rpc.SetDefaultPermissionMode({
				projectSlug: projectA,
				mode: "full",
			}),
		);
		await Effect.runPromise(
			browserA.rpc.SetDefaultModel({
				projectSlug: projectA,
				provider: "claude",
				model: "opus",
			}),
		);
		await Effect.runPromise(
			browserA.rpc.SetHiddenEntries({
				projectSlug: projectA,
				hiddenModels: ["claude/opus"],
				hiddenAgents: ["fixture-agent"],
			}),
		);
		await Effect.runPromise(
			browserA.rpc.SetClaudeSettings({
				projectSlug: projectA,
				overrides: { alwaysThinkingEnabled: true },
			}),
		);
		const expected: ProjectSetting[] = [
			{ _tag: "defaultPermissionMode", mode: "full" },
			{
				_tag: "defaultModel",
				provider: "claude",
				model: "opus",
				variant: "high",
			},
			{
				_tag: "visibility",
				hiddenModels: ["claude/opus"],
				hiddenAgents: ["fixture-agent"],
			},
			{ _tag: "claudeSettings", overrides: { alwaysThinkingEnabled: true } },
		];
		const changes = (received: readonly ProjectSettingsEnvelope[]) =>
			received.flatMap((envelope) =>
				envelope._tag === "upsert" &&
				envelope.item._tag !== "clientCount" &&
				envelope.item._tag !== "opencodeConnection"
					? [envelope.item]
					: [],
			);
		await expect.poll(() => changes(receivedB)).toEqual(expected);
		expect(changes(receivedA)).toEqual(expected);

		// Re-read from B's already-running relay, after observing the live changes.
		const fresh = await Effect.runPromise(
			browserB.rpc
				.SubscribeProjectSettings({ projectSlug: projectB })
				.pipe(Stream.take(1), Stream.runCollect),
		);
		snapshotB = [...fresh][0];
		expect(snapshotB?._tag).toBe("snapshot");
		if (snapshotB?._tag !== "snapshot") throw new Error("Missing B snapshot");
		for (const setting of expected)
			expect(snapshotB.rows).toContainEqual(setting);
		expect(loadRelaySettings(harness.configDir)).toMatchObject({
			defaultPermissionMode: "full",
			defaultModel: "claude/opus",
			defaultVariants: { "claude/opus": "high" },
		});

		// Flush both RPC frames together, before the daemon's bus consumer can
		// drain the older write and overwrite the newer writer's memory.
		let transport: Socket | undefined;
		const rpcUrl = new URL("/rpc", harness.baseUrl);
		rpcUrl.protocol = "ws:";
		batchedRpc = new WebSocket(rpcUrl, {
			perMessageDeflate: false,
			createConnection: () => {
				transport = connect(Number(rpcUrl.port), "127.0.0.1");
				return transport;
			},
		});
		batchedRpc.on("message", (data) => {
			const reply = JSON.parse(data.toString()) as
				| RpcMessage.FromServerEncoded
				| RpcMessage.FromServerEncoded[];
			replies.push(...(Array.isArray(reply) ? reply : [reply]));
		});
		await once(batchedRpc, "open");
		if (!transport) throw new Error("Missing RPC transport");
		transport.cork();
		for (const [id, projectSlug, mode] of [
			["1", projectA, "full"],
			["2", projectB, "auto"],
		] as const)
			batchedRpc.send(
				JSON.stringify({
					_tag: "Request",
					id,
					tag: "SetDefaultPermissionMode",
					payload: new SetDefaultPermissionMode({ projectSlug, mode }),
					headers: [],
				} satisfies RpcMessage.RequestEncoded),
			);
		transport.uncork();
		await expect
			.poll(() => replies)
			.toMatchObject([
				{ _tag: "Exit", requestId: "1", exit: { _tag: "Success" } },
				{ _tag: "Exit", requestId: "2", exit: { _tag: "Success" } },
			]);
		expect(loadRelaySettings(harness.configDir).defaultPermissionMode).toBe(
			"auto",
		);
		// Both live streams must finish at the persisted value, including B,
		// which the daemon skips when delivering B's own latest-write event.
		await expect
			.poll(() =>
				[receivedA, receivedB].map(
					(received) =>
						changes(received)
							.filter((setting) => setting._tag === "defaultPermissionMode")
							.at(-1)?.mode,
				),
			)
			.toEqual(["auto", "auto"]);
		await expect
			.poll(async () => {
				concurrentModes = await Promise.all(
					[projectA, projectB].map(async (projectSlug) => {
						const rows = await Effect.runPromise(
							browserA.rpc
								.SubscribeProjectSettings({ projectSlug })
								.pipe(Stream.take(1), Stream.runCollect),
						);
						const snapshot = [...rows][0];
						return snapshot?._tag === "snapshot"
							? snapshot.rows.find(
									(setting) => setting._tag === "defaultPermissionMode",
								)?.mode
							: undefined;
					}),
				);
				return concurrentModes;
			})
			.toEqual(["auto", "auto"]);

		const sessionId = await browserA.createSession("Global variant preference");
		await Effect.runPromise(
			browserA.rpc.SwitchVariant({
				projectSlug: projectA,
				sessionId,
				variant: "",
			}),
		);
		const expectedModel: ProjectSetting = {
			_tag: "defaultModel",
			provider: "claude",
			model: "opus",
			variant: "",
		};
		await expect
			.poll(() =>
				[receivedA, receivedB].map((received) =>
					changes(received)
						.filter((setting) => setting._tag === "defaultModel")
						.at(-1),
				),
			)
			.toEqual([expectedModel, expectedModel]);
		variantSnapshotB = [
			...(await Effect.runPromise(
				browserB.rpc
					.SubscribeProjectSettings({ projectSlug: projectB })
					.pipe(Stream.take(1), Stream.runCollect),
			)),
		][0];
		expect(
			variantSnapshotB?._tag === "snapshot" && variantSnapshotB.rows,
		).toContainEqual(expectedModel);
		expect(
			loadRelaySettings(harness.configDir).defaultVariants?.["claude/opus"],
		).toBe("");
		passed = true;
	} finally {
		writeFileSync(`${startupGate}-release`, "release");
		batchedRpc?.terminate();
		for (const subscriber of subscribers)
			await Effect.runPromise(Fiber.interrupt(subscriber));
		const persistedSettings = loadRelaySettings(harness.configDir);
		await harness.dispose();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/project-settings-fanout.json",
			JSON.stringify(
				{
					passed,
					receivedA,
					receivedB,
					snapshotB,
					variantSnapshotB,
					concurrentModes,
					replies,
					persistedSettings,
					process: harness.proof(),
				},
				null,
				2,
			),
		);
	}
}, 60_000);
