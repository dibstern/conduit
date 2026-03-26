// ─── Snapshot Recording Script ────────────────────────────────────────────────
// Spawns an ephemeral OpenCode instance, creates a RelayStack pointed at it,
// connects WS clients for each scenario, records all server→client messages,
// and saves them as JSON fixture files for replay-based E2E tests.
//
// Usage:
//   pnpm test:record-snapshots
//
// Environment variables:
//   E2E_MODEL     — model ID to use (default: big-pickle)
//   E2E_PROVIDER  — provider ID to use (default: opencode)
//   E2E_ALLOW_PAID — set to "1" to allow non-opencode providers (paid models)

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import WebSocket from "ws";
import { createLogger, createSilentLogger } from "../../../src/lib/logger.js";
import { createRelayStack } from "../../../src/lib/relay/relay-stack.js";
import { switchModelViaWs } from "../../helpers/opencode-utils.js";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type { MockMessage } from "../fixtures/mockup-state.js";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../fixtures/recorded/types.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";

/** A fully recorded session scenario captured from a real OpenCode instance. */
interface RecordedScenario {
	/** Human-readable scenario name (e.g. "chat-simple") */
	name: string;
	/** Model used during recording */
	model: string;
	/** ISO timestamp of when this was recorded */
	recordedAt: string;
	/** Messages sent on WS connect (session_switched, status, model_info, session_list, etc.) */
	initMessages: MockMessage[];
	/** Sequence of prompt → response event sequences */
	turns: RecordedTurn[];
}

interface RecordedTurn {
	/** Exact prompt text sent by the user */
	prompt: string;
	/** Full sequence of WS messages from server in response */
	events: MockMessage[];
}

// ─── Recording Post-Processing ──────────────────────────────────────────────

/**
 * Strip the /provider response down to only connected providers with a limited
 * number of models each. The full response is ~3 MB with 102 providers and
 * 3,400+ models; the relay only needs the 2 connected ones.
 */
function trimProviderResponse(interactions: OpenCodeInteraction[]): void {
	for (const ix of interactions) {
		if (ix.kind !== "rest" || ix.path !== "/provider") continue;
		const body = ix.responseBody as Record<string, unknown> | null;
		if (!body || typeof body !== "object") continue;

		const all = body["all"];
		const connected = body["connected"];
		if (!Array.isArray(all) || !Array.isArray(connected)) continue;

		// Keep only connected providers (and limit to 5 models each for size)
		const connectedSet = new Set(connected as string[]);
		const trimmed = (all as Array<Record<string, unknown>>)
			.filter((p) => connectedSet.has(p["id"] as string))
			.map((p) => {
				const models = p["models"];
				if (models && typeof models === "object" && !Array.isArray(models)) {
					const entries = Object.entries(models as Record<string, unknown>);
					p["models"] = Object.fromEntries(entries.slice(0, 5));
				}
				return p;
			});

		body["all"] = trimmed;
		ix.responseBody = body;
	}
}

// ─── Configuration ───────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/recorded");

/** Per-prompt timeout in ms. */
const PROMPT_TIMEOUT_MS = 120_000;

/** Time to wait after WS connect for init messages before sending first prompt. */
const INIT_SETTLE_MS = 2_000;

/** Extra wait after idle before closing to catch any trailing messages. */
const POST_IDLE_MS = 500;

// ─── Scenario Definitions ────────────────────────────────────────────────────

interface ScenarioDefinition {
	/** Output filename (without .json) */
	name: string;
	/** Prompts to send sequentially. */
	prompts: string[];
	/** If true, all prompts happen in the same session (multi-turn). */
	multiTurn?: boolean;
	/** If true, the scenario involves tool calls that require permission approval. */
	needsPermissionApproval?: boolean;
	/** If true, fork the session after all prompts, then send forkPrompt in the fork. */
	forkAfterPrompts?: boolean;
	/** Prompt to send in the forked session (requires forkAfterPrompts). */
	forkPrompt?: string;
}

const SCENARIOS: ScenarioDefinition[] = [
	{
		name: "chat-simple",
		prompts: [
			"Hello, reply with just the word pong",
			"Reply with just the word 'pong'. Nothing else.",
			"Reply with just the word 'ok'",
			"Reply with just the word 'hello'.",
			"Write a single JavaScript function called greet that returns 'hello'. Reply with ONLY the code block, no explanation.",
		],
		multiTurn: false,
	},
	{
		name: "chat-code-block",
		prompts: [
			"Write a single JavaScript function called greet that takes a name parameter and returns a greeting string. Reply with ONLY the code block, no explanation.",
		],
	},
	{
		name: "chat-tool-call",
		prompts: [
			'Read the file package.json and tell me the exact value of the "version" field.',
		],
		needsPermissionApproval: true,
	},
	{
		name: "chat-result-bar",
		prompts: ["Reply with just the word 'ok'. Nothing else."],
	},
	{
		name: "chat-multi-turn",
		prompts: [
			"Remember the word 'banana'. Reply with only: ok, remembered.",
			"What word did I ask you to remember? Reply with just the word.",
		],
		multiTurn: true,
	},
	{
		name: "chat-streaming",
		prompts: [
			"Write a paragraph explaining why automated testing is important for software quality.",
		],
	},
	{
		name: "chat-thinking",
		prompts: [
			"Go away and think for a bit to plan how you'll write this, considering the best possible style, and write a 300 word essay on agentic ai context management",
		],
	},
	{
		name: "permissions-read",
		prompts: ["Read the file package.json and tell me the name field"],
		needsPermissionApproval: true,
	},
	{
		name: "permissions-bash",
		prompts: ["List the files in the current directory using bash: ls -la"],
		needsPermissionApproval: true,
	},
	{
		name: "advanced-diff",
		prompts: [
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
			"Edit the file /tmp/e2e-test-diff.txt and change 'hello' to 'goodbye'",
			"Read the file /tmp/e2e-test-diff.txt and tell me its contents",
		],
		multiTurn: true,
		needsPermissionApproval: true,
	},
	{
		name: "advanced-mermaid",
		prompts: [
			"Draw a simple mermaid flowchart with 3 nodes: Start -> Process -> End. Use a mermaid code block.",
		],
	},
	{
		// 26 prompts × 2 messages each = 52 messages.
		// With default historyPageSize=50, the first REST history page
		// returns hasMore:true, enabling pagination E2E tests.
		name: "chat-paginated-history",
		prompts: Array.from(
			{ length: 26 },
			(_, i) => `Reply with just the number ${i + 1}. Nothing else.`,
		),
		multiTurn: true,
	},
	{
		name: "fork-session",
		prompts: [
			"Remember the word 'alpha'. Reply with only: ok, remembered.",
			"Now remember 'beta' too. Reply with only: ok, remembered.",
		],
		multiTurn: true,
		forkAfterPrompts: true,
		forkPrompt:
			"What words did I ask you to remember? Reply with just the words.",
	},
];

// ─── WS Helpers ──────────────────────────────────────────────────────────────

/** Connect a WebSocket to the relay and return it once open. */
function connectWs(relayPort: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("WS connect timeout"));
		}, 10_000);

		ws.on("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** Collect all WS messages arriving within a time window. */
function collectMessages(
	ws: WebSocket,
	durationMs: number,
): Promise<MockMessage[]> {
	return new Promise((resolve) => {
		const messages: MockMessage[] = [];
		const handler = (data: WebSocket.RawData) => {
			try {
				const msg = JSON.parse(String(data)) as MockMessage;
				messages.push(msg);
			} catch {
				// Ignore unparseable frames
			}
		};
		ws.on("message", handler);
		setTimeout(() => {
			ws.off("message", handler);
			resolve(messages);
		}, durationMs);
	});
}

/**
 * Send a prompt and record all server messages until idle.
 *
 * When `autoApprovePermissions` is true, the recorder auto-approves any
 * `permission_request` or `ask_user` messages that arrive during the turn.
 */
function recordTurn(
	ws: WebSocket,
	prompt: string,
	autoApprovePermissions: boolean,
): Promise<RecordedTurn> {
	return new Promise((resolve, reject) => {
		const events: MockMessage[] = [];
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				cleanup();
				reject(
					new Error(
						`Turn timed out after ${PROMPT_TIMEOUT_MS}ms. Prompt: "${prompt.slice(0, 60)}..."`,
					),
				);
			}
		}, PROMPT_TIMEOUT_MS);

		const handler = (data: WebSocket.RawData) => {
			if (resolved) return;
			try {
				const msg = JSON.parse(String(data)) as MockMessage;
				events.push(msg);

				// Auto-approve permission requests after a short delay.
				// The delay allows OpenCode's permission.asked SSE event to be
				// captured in the recording before the approval clears it.
				if (autoApprovePermissions && msg.type === "permission_request") {
					const requestId = msg["requestId"] as string;
					setTimeout(() => {
						ws.send(
							JSON.stringify({
								type: "permission_response",
								requestId,
								decision: "allow",
							}),
						);
					}, 3_000);
				}

				// Auto-approve ask_user questions (answer all with first option or "yes")
				if (autoApprovePermissions && msg.type === "ask_user") {
					const toolId = msg["toolId"] as string;
					const questions = msg["questions"] as
						| Array<{ options?: string[] }>
						| undefined;
					const answers: Record<string, string> = {};
					if (questions) {
						for (let i = 0; i < questions.length; i++) {
							const q = questions[i];
							answers[String(i)] = q?.options?.[0] ?? "yes";
						}
					} else {
						answers["0"] = "yes";
					}
					ws.send(
						JSON.stringify({
							type: "ask_user_response",
							toolId,
							answers,
						}),
					);
				}

				// The relay signals turn completion with { type: "done" } (NOT
				// { type: "status", status: "idle" }). The SSE idle hint is
				// consumed by the status poller which emits became_idle →
				// broadcasts { type: "done", code: 0 }.
				if (msg.type === "done") {
					// Wait a beat for any trailing messages
					setTimeout(() => {
						if (!resolved) {
							resolved = true;
							cleanup();
							resolve({ prompt, events });
						}
					}, POST_IDLE_MS);
				}
			} catch {
				// Ignore parse errors
			}
		};

		function cleanup() {
			clearTimeout(timer);
			ws.off("message", handler);
		}

		ws.on("message", handler);

		// Send the prompt
		ws.send(JSON.stringify({ type: "message", text: prompt }));
	});
}

/**
 * Request a new session via WS and wait for session_switched confirmation.
 */
function requestNewSession(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", handler);
			reject(new Error("Timeout waiting for new session"));
		}, 15_000);

		const handler = (data: WebSocket.RawData) => {
			try {
				const msg = JSON.parse(String(data)) as MockMessage;
				if (msg.type === "session_switched") {
					clearTimeout(timer);
					ws.off("message", handler);
					resolve();
				}
			} catch {
				// Ignore
			}
		};

		ws.on("message", handler);
		ws.send(JSON.stringify({ type: "new_session" }));
	});
}

/**
 * Fork the current session via WS and wait for session_forked + session_switched.
 * Returns the forked session's ID.
 */
function requestForkSession(ws: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", handler);
			reject(new Error("Timeout waiting for fork"));
		}, 15_000);

		let forkedId: string | undefined;

		const handler = (data: WebSocket.RawData) => {
			try {
				const msg = JSON.parse(String(data)) as MockMessage;
				if (msg.type === "session_forked") {
					const session = msg["session"] as { id?: string } | undefined;
					forkedId = session?.id;
				}
				if (msg.type === "session_switched" && forkedId) {
					clearTimeout(timer);
					ws.off("message", handler);
					resolve(forkedId);
				}
			} catch {
				// Ignore
			}
		};

		ws.on("message", handler);
		// Fork the current session (no messageId = whole-session fork)
		ws.send(JSON.stringify({ type: "fork_session" }));
	});
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Default to free OpenCode Zen model to avoid burning paid API quota.
	const modelId = process.env["E2E_MODEL"] || "big-pickle";
	const providerId = process.env["E2E_PROVIDER"] || "opencode";
	const allowPaid = process.env["E2E_ALLOW_PAID"] === "1";

	// Guard: abort if a non-opencode (paid) provider is selected without explicit opt-in.
	if (providerId !== "opencode" && !allowPaid) {
		console.error(
			`ERROR: Provider "${providerId}" is not a free OpenCode Zen provider.\n` +
				"Recording uses real API calls and will consume quota.\n" +
				"Use a free model:  E2E_PROVIDER=opencode E2E_MODEL=big-pickle\n" +
				"Or opt in to paid: E2E_ALLOW_PAID=1",
		);
		process.exit(1);
	}

	const scenarioFilter = process.env["SCENARIO"];
	const scenarios = scenarioFilter
		? SCENARIOS.filter((s) => s.name === scenarioFilter)
		: SCENARIOS;

	if (scenarioFilter && scenarios.length === 0) {
		console.error(`ERROR: No scenario named "${scenarioFilter}" found.`);
		process.exit(1);
	}

	console.log("=== Snapshot Recording Script ===");
	console.log(`Scenarios: ${scenarios.length}`);
	console.log(`Model: ${providerId}/${modelId}`);
	if (providerId === "opencode") {
		console.log("  (free OpenCode Zen model)");
	} else {
		console.log("  ⚠ PAID model (E2E_ALLOW_PAID=1)");
	}
	console.log();

	// 1. Spawn ephemeral OpenCode with tool permissions set to "ask"
	// so that permission.asked SSE events are captured in recordings.
	// Non-permission scenarios send simple prompts that don't trigger
	// tool calls, so this doesn't affect them.
	const needsPermissions = scenarios.some((s) => s.needsPermissionApproval);
	const permConfigPath = needsPermissions
		? path.join(process.cwd(), "opencode.json")
		: undefined;
	if (permConfigPath) {
		writeFileSync(
			permConfigPath,
			JSON.stringify(
				{
					$schema: "https://opencode.ai/config.json",
					permission: {
						read: "ask",
						write: "ask",
						edit: "ask",
						bash: "ask",
					},
				},
				null,
				"\t",
			),
		);
		console.log("Created temporary opencode.json with permission: ask");
	}

	console.log("Spawning ephemeral OpenCode...");
	const opencode = await spawnOpenCode({ timeoutMs: 60_000 });
	console.log(`  OpenCode running on port ${opencode.port}`);

	const proxy = new RecordingProxy(opencode.url);
	const verbose = process.env["VERBOSE"] === "1";

	try {
		// 2. Start recording proxy in front of OpenCode
		console.log("Starting recording proxy...");
		await proxy.start();
		console.log(`  Proxy forwarding to OpenCode via ${proxy.url}`);

		// 3. Ensure output directory exists
		mkdirSync(FIXTURES_DIR, { recursive: true });

		// 4. Record each scenario (fresh relay per scenario to capture init sequence)
		for (const scenario of scenarios) {
			console.log(`\nRecording: ${scenario.name}`);
			console.log(`  Prompts: ${scenario.prompts.length}`);

			// Reset proxy BEFORE relay creation so the recording captures the
			// full init sequence (GET /path, GET /config, GET /command, etc.)
			proxy.reset();

			let relayStack: Awaited<ReturnType<typeof createRelayStack>> | undefined;
			try {
				// Create a fresh RelayStack for this scenario
				console.log("  Creating RelayStack...");
				relayStack = await createRelayStack({
					port: 0, // Ephemeral port
					opencodeUrl: proxy.url,
					projectDir: process.cwd(),
					slug: "e2e-record",
					log: verbose ? createLogger("e2e-record") : createSilentLogger(),
				});
				const relayPort = relayStack.getPort();
				console.log(`  Relay listening on port ${relayPort}`);

				// Switch to the recording model
				console.log(`  Switching model to ${providerId}/${modelId}...`);
				await switchModelViaWs(relayPort, modelId, providerId);
				console.log("  Model switched.");

				const ws = await connectWs(relayPort);

				try {
					// Collect init messages
					const initMessages = await collectMessages(ws, INIT_SETTLE_MS);
					console.log(`  Init messages: ${initMessages.length}`);

					const turns: RecordedTurn[] = [];

					if (scenario.multiTurn) {
						// Multi-turn: all prompts in the same session.
						// The relay's init session is guaranteed fresh by
						// inter-scenario session cleanup — no need to create
						// a second session.

						for (let i = 0; i < scenario.prompts.length; i++) {
							// biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
							const prompt = scenario.prompts[i]!;
							console.log(
								`  Turn ${i + 1}: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`,
							);
							const turn = await recordTurn(
								ws,
								prompt,
								scenario.needsPermissionApproval === true,
							);
							console.log(`    Events: ${turn.events.length}`);
							turns.push(turn);
						}

						// Handle fork scenario: fork the session and send one more prompt
						if (scenario.forkAfterPrompts && scenario.forkPrompt) {
							console.log("  Forking session...");
							const forkedId = await requestForkSession(ws);
							console.log(`  Forked to: ${forkedId}`);

							// Wait for fork to settle (session switch, list updates)
							await collectMessages(ws, 1_500);

							console.log(
								`  Fork turn: "${scenario.forkPrompt.slice(0, 50)}${scenario.forkPrompt.length > 50 ? "..." : ""}"`,
							);
							const forkTurn = await recordTurn(
								ws,
								scenario.forkPrompt,
								scenario.needsPermissionApproval === true,
							);
							console.log(`    Events: ${forkTurn.events.length}`);
							turns.push(forkTurn);
						}
					} else {
						// Single-turn: each prompt gets its own session
						for (let i = 0; i < scenario.prompts.length; i++) {
							// biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
							const prompt = scenario.prompts[i]!;

							if (i > 0) {
								// Create a new session for each prompt after the first.
								// The first prompt uses the relay's init session, which is
								// guaranteed fresh by inter-scenario session cleanup.
								await requestNewSession(ws);
								await collectMessages(ws, 1_000);
							}

							console.log(
								`  Turn ${i + 1}: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`,
							);
							const turn = await recordTurn(
								ws,
								prompt,
								scenario.needsPermissionApproval === true,
							);
							console.log(`    Events: ${turn.events.length}`);
							turns.push(turn);
						}
					}

					// For multi-turn scenarios, fetch message history through the
					// proxy so the recording contains non-empty GET /session/:id/message
					// responses. This is needed for pagination E2E tests that load
					// history via REST instead of the SSE events cache.
					if (scenario.multiTurn) {
						const sessions = await fetch(`${proxy.url}/session`).then(
							(r) => r.json() as Promise<Array<{ id: string }>>,
						);
						if (sessions.length > 0) {
							// biome-ignore lint/style/noNonNullAssertion: checked length
							const sid = sessions[sessions.length - 1]!.id;
							await fetch(`${proxy.url}/session/${sid}/message`);
							console.log(`  Captured message history for ${sid}`);
						}
					}

					// Build and save fixture
					const recorded: RecordedScenario = {
						name: scenario.name,
						model: `${providerId}/${modelId}`,
						recordedAt: new Date().toISOString(),
						initMessages,
						turns,
					};

					const outPath = path.join(FIXTURES_DIR, `${scenario.name}.json`);
					writeFileSync(outPath, `${JSON.stringify(recorded, null, "\t")}\n`);
					console.log(`  Saved: ${outPath}`);

					// Save OpenCode HTTP-level recording BEFORE stopping the relay —
					// stop generates teardown HTTP traffic (SSE disconnect) that
					// would pollute the recording.
					const interactions = proxy.getRecording();
					trimProviderResponse(interactions);

					// Try to extract OpenCode version from the first REST response
					let opencodeVersion = "unknown";
					for (const ix of interactions) {
						if (ix.kind === "rest") {
							const body = ix.responseBody;
							if (
								body &&
								typeof body === "object" &&
								"version" in body &&
								typeof (body as { version: unknown }).version === "string"
							) {
								opencodeVersion = (body as { version: string }).version;
								break;
							}
						}
					}

					const openCodeRecording: OpenCodeRecording = {
						name: scenario.name,
						recordedAt: new Date().toISOString(),
						opencodeVersion,
						interactions,
					};

					const openCodeJson = JSON.stringify(openCodeRecording, null, "\t");
					const ocOutPath = path.join(
						FIXTURES_DIR,
						`${scenario.name}.opencode.json.gz`,
					);
					writeFileSync(ocOutPath, gzipSync(Buffer.from(openCodeJson)));
					console.log(`  Saved: ${ocOutPath}`);
				} finally {
					ws.close();
				}
			} finally {
				// Stop relay with timeout to prevent hangs from lingering keep-alive connections
				if (relayStack) {
					console.log("  Stopping relay...");
					const stopPromise = relayStack.stop();
					await Promise.race([
						stopPromise,
						new Promise<void>((resolve) =>
							setTimeout(() => {
								console.warn("  Relay stop timed out after 10s, moving on.");
								resolve();
							}, 10_000),
						),
					]);
					// Prevent unhandled rejection if stop() rejects after timeout
					stopPromise.catch((err: unknown) =>
						console.warn("  Relay stop eventually failed:", err),
					);
				}
			}

			// Clean up all sessions from the ephemeral OpenCode instance
			// so the next scenario starts with a clean session list.
			// Use the raw OpenCode URL (not the proxy) to keep cleanup
			// traffic out of the recording.
			try {
				const res = await fetch(`${opencode.url}/session`);
				if (res.ok) {
					const sessions = (await res.json()) as { id: string }[];
					if (sessions.length > 0) {
						console.log(`  Cleaning up ${sessions.length} session(s)...`);
						await Promise.all(
							sessions.map((s) =>
								fetch(`${opencode.url}/session/${s.id}`, {
									method: "DELETE",
								}),
							),
						);
					}
				}
			} catch (err) {
				console.warn("  Session cleanup failed:", err);
			}
		}

		console.log("\n=== Recording Complete ===");
		console.log(`Fixtures saved to: ${FIXTURES_DIR}`);
	} finally {
		// 5. Cleanup
		if (permConfigPath) {
			try {
				unlinkSync(permConfigPath);
				console.log("Removed temporary opencode.json");
			} catch {
				// Ignore if already removed
			}
		}
		console.log("\nStopping recording proxy...");
		await proxy.stop();
		console.log("Stopping OpenCode...");
		opencode.stop();
		console.log("Done.");
	}
}

main().catch((err) => {
	console.error("Recording failed:", err);
	process.exit(1);
});
