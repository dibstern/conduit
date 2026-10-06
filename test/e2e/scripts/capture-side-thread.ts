// Capture the Side Thread replay fixture from a real ephemeral OpenCode.
// Run: pnpm exec tsx test/e2e/scripts/capture-side-thread.ts [fork-reply]
// "fork-reply" records two parent turns, a fork from the first reply and a
// turn in the fork instead.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import WebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { createRelayStack } from "../../../src/lib/relay/relay-stack.js";
import { stopPtyHost } from "../../../src/lib/terminal/pty-host-client.js";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type { MockMessage } from "../fixtures/mockup-state.js";
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";

const scenario =
	process.argv[2] === "fork-reply" ? "fork-reply" : "side-thread";
const projectSlug = "side-thread-recording";
const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const secondPrompt =
	"Now remember the word 'beta' too. Reply with only: ok, remembered.";
const forkPrompt =
	"Which words did I ask you to remember? Reply with only the words.";
const question =
	"What word did I ask you to remember? Reply with only the word.";
const raisedPrompt = "Reply with only: ok, raised.";
const configDir = mkdtempSync(path.join(tmpdir(), "side-thread-recording-"));
const opencode = await spawnOpenCode({ timeoutMs: 60_000 });
const proxy = new RecordingProxy(opencode.url);
let stack: Awaited<ReturnType<typeof createRelayStack>> | undefined;
let ws: WebSocket | undefined;

try {
	await proxy.start();
	saveRelaySettings({ defaultModel: "opencode/big-pickle" }, configDir);
	stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl: proxy.url,
		projectDir: process.cwd(),
		slug: projectSlug,
		configDir,
		persistenceDbPath: path.join(configDir, "events.db"),
		log: createSilentLogger(),
	});
	const relayPort = stack.getPort();
	const originId = `record-${randomUUID()}`;
	const captured: MockMessage[] = [];
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

	async function rpc<A>(
		call: (
			client: RpcClient.FromGroup<typeof WsRpcGroup, unknown>,
		) => Effect.Effect<A, unknown>,
	): Promise<A> {
		return Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					return yield* call(yield* RpcClient.make(WsRpcGroup));
				}),
			).pipe(
				Effect.provide(RpcClient.layerProtocolSocket()),
				Effect.provide(
					Socket.layerWebSocket(`ws://127.0.0.1:${relayPort}/rpc`),
				),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
	}

	async function recordTurn(sessionId: string, prompt: string) {
		const firstMessage = captured.length;
		await rpc((client) =>
			client.ViewSession({ projectSlug, sessionId, originId }),
		);
		await rpc((client) =>
			client.SendMessage({
				projectSlug,
				sessionId,
				text: prompt,
				commandId: randomUUID(),
				originId,
			}),
		);
		const deadline = Date.now() + 120_000;
		while (
			!captured.slice(firstMessage).some((message) => message.type === "done")
		) {
			const error = captured
				.slice(firstMessage)
				.find((message) => message.type === "error");
			if (error) throw new Error(JSON.stringify(error));
			if (Date.now() >= deadline) throw new Error(`Turn timed out: ${prompt}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		console.log(`Completed turn in ${sessionId}`);
		return { prompt, events: captured.slice(firstMessage) };
	}

	// The parent is the first session OpenCode creates, as the replay harness
	// creates its session first; attaching the socket to it skips the default.
	const parent = await rpc((client) =>
		client.CreateSession({
			projectSlug,
			originId,
			providerId: "opencode",
			title: "Remember alpha",
		}),
	);
	const socket = new WebSocket(
		`ws://127.0.0.1:${relayPort}/ws?p=${projectSlug}&client=${originId}&session=${parent.sessionId}`,
	);
	ws = socket;
	socket.on("message", (data: WebSocket.RawData) => {
		captured.push(JSON.parse(String(data)) as MockMessage);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const initMessages = [...captured];
	await rpc((client) =>
		client.SwitchModel({
			projectSlug,
			sessionId: parent.sessionId,
			providerId: "opencode",
			modelId: "big-pickle",
		}),
	);
	// Replays read the agent catalogue, which only GetAgents fetches.
	await rpc((client) =>
		client.GetAgents({ projectSlug, sessionId: parent.sessionId }),
	);
	const turns = [await recordTurn(parent.sessionId, parentPrompt)];
	if (scenario === "fork-reply") {
		turns.push(await recordTurn(parent.sessionId, secondPrompt));
		// Read OpenCode directly so the lookup stays out of the recording.
		const history = (await (
			await fetch(`${opencode.url}/session/${parent.sessionId}/message`)
		).json()) as { info: { id: string; role: string } }[];
		const secondTurn = history
			.map((message) => message.info.role)
			.lastIndexOf("user");
		const firstReply = history[secondTurn - 1]?.info.id;
		if (!firstReply) throw new Error("First reply not found");
		const fork = await rpc((client) =>
			client.ForkSession({
				projectSlug,
				originId,
				sessionId: parent.sessionId,
				messageId: firstReply,
			}),
		);
		turns.push(await recordTurn(fork.sessionId, forkPrompt));
		await fetch(`${proxy.url}/session/${fork.sessionId}/message`);
	} else {
		const side = await rpc((client) =>
			client.StartSideThread({
				projectSlug,
				parentSessionId: parent.sessionId,
				title: question,
			}),
		);
		turns.push(await recordTurn(side.sessionId, question));
		// Raising the mode appends the raised rules; the next prompt drops "plan".
		await rpc((client) =>
			client.SwitchPermissionMode({
				projectSlug,
				sessionId: side.sessionId,
				mode: "ask",
			}),
		);
		turns.push(await recordTurn(side.sessionId, raisedPrompt));
		await fetch(`${proxy.url}/session/${side.sessionId}/message`);
	}
	await fetch(`${proxy.url}/session`);

	const interactions = proxy.getRecording();
	// Match the existing recorder's catalogue trimming; no secret values are kept.
	for (const interaction of interactions) {
		if (
			interaction.kind !== "rest" ||
			interaction.path.split("?")[0] !== "/provider"
		)
			continue;
		const body = interaction.responseBody as Record<string, unknown>;
		const providers = body["all"];
		if (Array.isArray(providers)) {
			body["all"] = providers.filter(
				(provider: Record<string, unknown>) => provider["id"] === "opencode",
			);
			body["connected"] = ["opencode"];
		}
	}
	const recording: OpenCodeRecording = {
		name: scenario,
		recordedAt: new Date().toISOString(),
		opencodeVersion:
			interactions.flatMap((interaction) => {
				if (
					interaction.kind !== "rest" ||
					!interaction.responseBody ||
					typeof interaction.responseBody !== "object"
				)
					return [];
				const version = (interaction.responseBody as Record<string, unknown>)[
					"version"
				];
				return typeof version === "string" ? [version] : [];
			})[0] ?? "unknown",
		interactions,
	};
	const fixtureDir = path.resolve(import.meta.dirname, "../fixtures/recorded");
	writeFileSync(
		path.join(fixtureDir, `${scenario}.json`),
		`${JSON.stringify(
			{
				name: scenario,
				model: "opencode/big-pickle",
				recordedAt: recording.recordedAt,
				initMessages,
				turns,
			},
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(
		path.join(fixtureDir, `${scenario}.opencode.json.gz`),
		gzipSync(JSON.stringify(recording, null, "\t")),
	);
	console.log(
		`Saved Side Thread capture with ${interactions.length} REST/SSE interactions`,
	);
} finally {
	ws?.close();
	if (stack) await stack.stop();
	await stopPtyHost({ configDir, force: true });
	proxy.reset();
	await proxy.stop();
	opencode.stop();
	rmSync(configDir, { recursive: true, force: true });
}
