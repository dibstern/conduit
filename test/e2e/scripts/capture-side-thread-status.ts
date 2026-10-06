// Capture real REST/SSE traffic for Side Thread status and attention roll-ups.
// Run with no argument, "permission", "question", or "mid-turn" (a Side Thread
// started while the parent runs a tool). Existing fixtures stay intact.
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

const scenario = process.argv[2] ?? "status";
if (!["status", "permission", "question", "mid-turn"].includes(scenario)) {
	throw new Error("Expected status, permission, question, or mid-turn");
}
const name = `side-thread-${scenario}`;
const projectSlug = "side-thread-status-recording";
const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	scenario === "permission"
		? "Use the bash tool to run printf 'side-thread-approval'. Do not answer without running this command."
		: scenario === "question"
			? "Use the question tool to ask me to choose between Alpha and Beta, with header Choice and question Which word should we use? Wait for my answer before continuing."
			: "What word did I ask you to remember? Reply with only the word.";
const parentFollowUp =
	scenario === "mid-turn"
		? "Use the bash tool to run: sleep 10; printf mid-turn-marker. Then reply with only its output."
		: "What word are you remembering? Reply with only the word.";
const configDir = mkdtempSync(path.join(tmpdir(), `${name}-config-`));
const projectDir = mkdtempSync(path.join(tmpdir(), `${name}-project-`));
const opencode = await spawnOpenCode({
	timeoutMs: 60_000,
	env: {
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			permission: {
				bash: scenario === "mid-turn" ? "allow" : "ask",
				question: "allow",
			},
		}),
	},
});
const proxy = new RecordingProxy(opencode.url);
let stack: Awaited<ReturnType<typeof createRelayStack>> | undefined;
let ws: WebSocket | undefined;
const previousWebSocket = globalThis.WebSocket;

try {
	console.log(`Capturing ${name} from OpenCode at ${opencode.url}`);
	await proxy.start();
	await fetch(`${proxy.url}/global/health`);
	saveRelaySettings({ defaultModel: "opencode/big-pickle" }, configDir);
	stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl: proxy.url,
		projectDir,
		slug: projectSlug,
		configDir,
		persistenceDbPath: path.join(configDir, "events.db"),
		log: createSilentLogger(),
	});
	const relayPort = stack.getPort();
	const originId = `record-${randomUUID()}`;
	const socket = new WebSocket(
		`ws://127.0.0.1:${relayPort}/ws?p=${projectSlug}&client=${originId}`,
	);
	ws = socket;
	const captured: MockMessage[] = [];
	socket.on("message", (data: WebSocket.RawData) => {
		captured.push(JSON.parse(String(data)) as MockMessage);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const initMessages = [...captured];
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

	async function recordTurn(
		sessionId: string,
		prompt: string,
		viewId = sessionId,
	) {
		const firstMessage = captured.length;
		const firstInteraction = proxy.getRecording().length;
		await rpc((client) =>
			client.ViewSession({ projectSlug, sessionId, originId }),
		);
		await rpc((client) =>
			client.input.submit({
				projectSlug,
				sessionId,
				text: prompt,
				inputId: randomUUID(),
				delivery: "queue",
				originId,
			}),
		);
		if (viewId !== sessionId) {
			await rpc((client) =>
				client.ViewSession({ projectSlug, sessionId: viewId, originId }),
			);
		}
		const deadline = Date.now() + 120_000;
		let responded = false;
		while (true) {
			const messages = captured.slice(firstMessage);
			const error = messages.find((message) => message.type === "error");
			if (error) throw new Error(JSON.stringify(error));
			if (!responded) {
				const approval = messages.find(
					(message) => message.type === "permission_request",
				);
				const asked = messages.find((message) => message.type === "ask_user");
				const providerQuestion = proxy
					.getRecording()
					.find(
						(interaction) =>
							interaction.kind === "sse" &&
							interaction.type === "question.asked" &&
							interaction.properties["sessionID"] === sessionId,
					);
				if (approval || asked || providerQuestion) {
					responded = true;
					// Keep the real pending request observable in the recording.
					await new Promise((resolve) => setTimeout(resolve, 1_500));
					if (approval) {
						await rpc((client) =>
							client.RespondPermission({
								projectSlug,
								originId,
								commandId: randomUUID(),
								requestId: String(approval["requestId"]),
								decision: "allow",
							}),
						);
					} else if (asked) {
						await rpc((client) =>
							client.AnswerQuestion({
								projectSlug,
								originId,
								commandId: randomUUID(),
								toolId: String(asked["toolId"]),
								answers: { "0": "Alpha" },
							}),
						);
					} else if (providerQuestion?.kind === "sse") {
						// This relay currently persists OpenCode questions without pushing
						// ask_user. Capture the real provider reply instead of inventing one.
						const id = providerQuestion.properties["id"];
						if (typeof id !== "string") throw new Error("Question has no id");
						const reply = await fetch(
							`${proxy.url}/question/${id}/reply?directory=${encodeURIComponent(projectDir)}`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ answers: [["Alpha"]] }),
							},
						);
						if (!reply.ok)
							throw new Error(`Question reply returned ${reply.status}`);
						console.log(
							"Answered captured question through provider API; relay did not push ask_user",
						);
					}
				}
			}
			// Provider idle also observes turns completed while viewing another session.
			const interactions = proxy.getRecording();
			let lastPrompt = interactions.length - 1;
			while (lastPrompt >= firstInteraction) {
				const interaction = interactions[lastPrompt];
				if (
					interaction?.kind === "rest" &&
					interaction.method === "POST" &&
					interaction.path.split("?")[0] ===
						`/session/${sessionId}/prompt_async`
				)
					break;
				lastPrompt--;
			}
			if (
				lastPrompt >= firstInteraction &&
				interactions
					.slice(lastPrompt + 1)
					.some(
						(interaction) =>
							interaction.kind === "sse" &&
							interaction.type === "session.status" &&
							interaction.properties["sessionID"] === sessionId &&
							(interaction.properties["status"] as { type?: string })?.type ===
								"idle",
					)
			)
				break;
			if (Date.now() >= deadline) throw new Error(`Turn timed out: ${prompt}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		console.log(`Completed turn in ${sessionId}`);
		return { prompt, events: captured.slice(firstMessage) };
	}

	const parentId = stack.initialSessionId;
	if (!parentId)
		throw new Error("Capture needs the relay's initial OpenCode session");
	const turns = [await recordTurn(parentId, parentPrompt)];
	const startSideThread = () =>
		rpc((client) =>
			client.StartSideThread({
				projectSlug,
				parentSessionId: parentId,
				title: question,
			}),
		);
	const side =
		scenario === "mid-turn"
			? await recordMidTurnSideThread()
			: await startSideThread();
	if (scenario !== "mid-turn")
		turns.push(await recordTurn(side.sessionId, question));
	if (scenario === "status") {
		turns.push(await recordTurn(parentId, parentFollowUp, side.sessionId));
	}

	// Fork while the parent's bash tool runs, then let both turns finish.
	async function recordMidTurnSideThread() {
		const firstInteraction = proxy.getRecording().length;
		const parentTurn = recordTurn(parentId, parentFollowUp);
		const runningTool = () =>
			proxy
				.getRecording()
				.slice(firstInteraction)
				.find((interaction) => {
					if (
						interaction.kind !== "sse" ||
						interaction.type !== "message.part.updated"
					)
						return false;
					const part = interaction.properties["part"] as
						| { sessionID?: string; type?: string; state?: { status?: string } }
						| undefined;
					return (
						part?.sessionID === parentId &&
						part.type === "tool" &&
						part.state?.status === "running"
					);
				});
		const deadline = Date.now() + 60_000;
		while (!runningTool()) {
			if (Date.now() >= deadline) throw new Error("Parent tool never ran");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const started = await startSideThread();
		turns.push(await recordTurn(started.sessionId, question));
		turns.push(await parentTurn);
		return started;
	}
	const directoryQuery = `?directory=${encodeURIComponent(projectDir)}`;
	await fetch(
		`${proxy.url}/session/${side.sessionId}/message${directoryQuery}`,
	);
	await fetch(`${proxy.url}/session${directoryQuery}`);
	const interactions = proxy.getRecording();
	const requiredType =
		scenario === "permission"
			? "permission.asked"
			: scenario === "question"
				? "question.asked"
				: "session.status";
	if (
		!interactions.some(
			(interaction) =>
				interaction.kind === "sse" && interaction.type === requiredType,
		)
	) {
		throw new Error(`Live capture did not include ${requiredType}`);
	}
	if (scenario === "mid-turn") {
		// Evidence from real OpenCode: where conduit cut the fork, and what the
		// fork holds. The fork must land while the parent is still busy.
		const isRest =
			(method: string, route: string) =>
			(interaction: (typeof interactions)[number]) =>
				interaction.kind === "rest" &&
				interaction.method === method &&
				interaction.path.split("?")[0] === route;
		const forkIndex = interactions.findIndex(
			isRest("POST", `/session/${parentId}/fork`),
		);
		const parentIdlesBeforeFork = interactions
			.slice(0, forkIndex)
			.filter(
				(interaction) =>
					interaction.kind === "sse" &&
					interaction.type === "session.idle" &&
					interaction.properties["sessionID"] === parentId,
			).length;
		if (forkIndex < 0 || parentIdlesBeforeFork !== 1)
			throw new Error("The Side Thread did not fork during the second turn");
		const info = (interaction: (typeof interactions)[number]) =>
			interaction.kind === "sse" && interaction.type === "message.updated"
				? (interaction.properties["info"] as {
						id: string;
						role: string;
						sessionID: string;
					})
				: undefined;
		const fork = interactions[forkIndex];
		const sideHistory = interactions
			.filter(isRest("GET", `/session/${side.sessionId}/message`))
			.at(-1);
		console.log(
			JSON.stringify({
				forkBody: fork?.kind === "rest" ? fork.requestBody : undefined,
				parentUserMessageIds: [
					...new Set(
						interactions
							.map(info)
							.filter((message) => message?.sessionID === parentId)
							.filter((message) => message?.role === "user")
							.map((message) => message?.id),
					),
				],
				sideHistory:
					sideHistory?.kind === "rest"
						? (
								sideHistory.responseBody as {
									info: { id: string; role: string };
									parts: { type: string; text?: string; tool?: string }[];
								}[]
							).map((message) => [
								message.info.role,
								message.parts.map(
									(part) => part.text ?? part.tool ?? part.type,
								),
							])
						: undefined,
			}),
		);
	}
	// Same provider catalogue trimming as the existing recorder.
	for (const interaction of interactions) {
		if (
			interaction.kind !== "rest" ||
			interaction.path.split("?")[0] !== "/provider"
		)
			continue;
		const body = interaction.responseBody as Record<string, unknown>;
		if (Array.isArray(body["all"])) {
			body["all"] = (body["all"] as Record<string, unknown>[]).filter(
				(provider) => provider["id"] === "opencode",
			);
			body["connected"] = ["opencode"];
		}
	}
	const health = interactions.find(
		(interaction) =>
			interaction.kind === "rest" &&
			interaction.path.split("?")[0] === "/global/health",
	);
	const recording: OpenCodeRecording = {
		name,
		recordedAt: new Date().toISOString(),
		opencodeVersion:
			health?.kind === "rest" &&
			health.responseBody &&
			typeof health.responseBody === "object" &&
			"version" in health.responseBody
				? String(health.responseBody.version)
				: "unknown",
		interactions,
	};
	const fixtureDir = path.resolve(import.meta.dirname, "../fixtures/recorded");
	writeFileSync(
		path.join(fixtureDir, `${name}.json`),
		`${JSON.stringify({ name, model: "opencode/big-pickle", recordedAt: recording.recordedAt, initMessages, turns }, null, "\t")}\n`,
	);
	writeFileSync(
		path.join(fixtureDir, `${name}.opencode.json.gz`),
		gzipSync(JSON.stringify(recording, null, "\t")),
	);
	console.log(
		`Saved ${name} with ${interactions.length} real REST/SSE interactions`,
	);
} finally {
	globalThis.WebSocket = previousWebSocket;
	ws?.close();
	if (stack) await stack.stop();
	await stopPtyHost({ configDir, force: true });
	proxy.reset();
	await proxy.stop();
	opencode.stop();
	rmSync(configDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
}
