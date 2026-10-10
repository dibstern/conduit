/**
 * Capture how the installed OpenCode server takes a second prompt sent while a
 * tool runs, through the v2 prompt call (`POST /api/session/:id/prompt`, with
 * `delivery` "steer" or "queue") and through the classic `prompt_async` call
 * conduit uses today. Answers, from the wire (ADR-0002):
 *   (a) does it emit `session.next.prompted`?
 *   (b) does it honour `delivery: "steer"` (placed into the running turn at
 *       the tool boundary rather than queued after it)?
 *   (c) does the prompt call return the new message's id?
 *
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/opencode-steer-wire-capture.test.ts
 *
 * Spawns an ephemeral OpenCode server, prompts a free OpenCode Zen model in a
 * temp directory, records every REST call and SSE event through a
 * RecordingProxy, and writes one OpenCodeRecording per scenario to
 * test/fixtures/opencode-wire-traces/ after its assertions pass. Review the
 * recordings before committing them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const FIXTURE_DIR = join(
	import.meta.dirname,
	"../../fixtures/opencode-wire-traces",
);
const TOOL_PROMPT =
	"Use the bash tool to run exactly: sleep 10 && echo first-done . Then reply with the single word FIRST.";
const SECOND_PROMPT = "Also reply with the single word SECOND.";
// A free OpenCode Zen model, so the capture needs no credentials.
const MODEL = {
	providerID: "opencode",
	id: process.env["E2E_MODEL"] ?? "big-pickle",
};

// The proxy forwards OpenCode's content-encoding over a body fetch already
// decoded, so ask for unencoded responses.
const IDENTITY = { "accept-encoding": "identity" };

interface WireEvent {
	readonly type: string;
	readonly properties: Record<string, unknown>;
}

/** One scenario's live connection: REST through the proxy, SSE in order. */
interface Wire {
	readonly events: WireEvent[];
	post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
	get(path: string): Promise<unknown>;
	waitFor(
		what: string,
		match: (event: WireEvent) => boolean,
		timeoutMs?: number,
	): Promise<number>;
}

async function recordScenario(
	upstreamUrl: string,
	directory: string,
	name: string,
	run: (wire: Wire) => Promise<void>,
): Promise<OpenCodeRecording> {
	const proxy = new RecordingProxy(upstreamUrl);
	await proxy.start();
	const query = `directory=${encodeURIComponent(directory)}`;
	const url = (path: string) =>
		`${proxy.url}${path}${path.includes("?") ? "&" : "?"}${query}`;
	const events: WireEvent[] = [];
	const controller = new AbortController();
	const response = await fetch(url("/event"), { signal: controller.signal });
	const reader = response.body?.getReader();
	if (!reader) throw new Error("No SSE body");
	const pump = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split("\n\n");
				buffer = blocks.pop() ?? "";
				for (const line of blocks.flatMap((block) => block.split("\n"))) {
					if (!line.startsWith("data: ")) continue;
					const event = JSON.parse(line.slice(6)) as WireEvent;
					events.push({ type: event.type, properties: event.properties });
				}
			}
		} catch {
			// Aborted at the end of the scenario.
		}
	})();
	const wire: Wire = {
		events,
		async post(path, body) {
			const res = await fetch(url(path), {
				method: "POST",
				headers: { ...IDENTITY, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : undefined };
		},
		async get(path) {
			return (await fetch(url(path), { headers: IDENTITY })).json();
		},
		async waitFor(what, match, timeoutMs = 90_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const index = events.findIndex(match);
				if (index >= 0) return index;
				const failed = events.find(
					(e) =>
						e.type === "session.next.step.failed" || e.type === "session.error",
				);
				if (failed) {
					throw new Error(
						`${name}: ${failed.type} while waiting for ${what}: ${JSON.stringify(failed.properties)}`,
					);
				}
				if (Date.now() > deadline) {
					throw new Error(
						`${name}: timed out waiting for ${what}; saw ${events.map((e) => e.type).join(", ")}`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		},
	};
	try {
		await wire.waitFor(
			"server.connected",
			(e) => e.type === "server.connected",
		);
		await run(wire);
	} finally {
		controller.abort();
		await pump;
		await proxy.stop();
	}
	return {
		name,
		recordedAt: new Date().toISOString(),
		opencodeVersion: (
			(await (await fetch(`${upstreamUrl}/global/health`)).json()) as {
				version: string;
			}
		).version,
		interactions: proxy.getRecording(),
	};
}

const ofSession =
	(sessionID: string, type: string) =>
	(event: WireEvent): boolean =>
		event.type === type && event.properties["sessionID"] === sessionID;

const indexOf = (
	events: readonly WireEvent[],
	match: (event: WireEvent) => boolean,
): number => events.findIndex(match);

const admittedId = (body: unknown): string =>
	(body as { data: { id: string } }).data.id;

/** A v2 session: the first prompt runs a bash sleep, the second arrives
 *  while it runs with the given delivery. Returns the facts to assert. */
async function v2SecondPromptDuringTool(
	wire: Wire,
	delivery: "steer" | "queue",
) {
	const session = await wire.post("/session", { title: `v2-${delivery}` });
	const sessionID = (session.body as { id: string }).id;
	await wire.post(`/api/session/${sessionID}/model`, { model: MODEL });
	const first = await wire.post(`/api/session/${sessionID}/prompt`, {
		prompt: { text: TOOL_PROMPT },
	});
	await wire.waitFor(
		"the bash tool call",
		ofSession(sessionID, "session.next.tool.called"),
	);
	const second = await wire.post(`/api/session/${sessionID}/prompt`, {
		prompt: { text: SECOND_PROMPT },
		delivery,
	});
	const firstId = admittedId(first.body);
	const secondId = admittedId(second.body);
	const promptedFor = (id: string) => (event: WireEvent) =>
		ofSession(sessionID, "session.next.prompted")(event) &&
		event.properties["messageID"] === id;
	const started = await wire.waitFor(
		"the second prompt to start",
		promptedFor(secondId),
	);
	await wire.waitFor(
		"the second prompt's turn to end",
		(event) =>
			wire.events.indexOf(event) > started &&
			ofSession(sessionID, "session.next.step.ended")(event) &&
			event.properties["finish"] !== "tool-calls",
	);
	const { events } = wire;
	return {
		sessionID,
		first,
		second,
		firstId,
		secondId,
		firstPrompted: indexOf(events, promptedFor(firstId)),
		secondPrompted: indexOf(events, promptedFor(secondId)),
		secondAdmitted: indexOf(
			events,
			(e) =>
				ofSession(sessionID, "session.next.prompt.admitted")(e) &&
				e.properties["messageID"] === secondId,
		),
		toolSuccess: indexOf(
			events,
			ofSession(sessionID, "session.next.tool.success"),
		),
		stepEnds: events.flatMap((e, i) =>
			ofSession(sessionID, "session.next.step.ended")(e) ? [i] : [],
		),
		stepStarts: events.flatMap((e, i) =>
			ofSession(sessionID, "session.next.step.started")(e) ? [i] : [],
		),
		classicEvents: events.filter(
			(e) =>
				(e.type.startsWith("message.") ||
					e.type.startsWith("session.status")) &&
				JSON.stringify(e.properties).includes(sessionID),
		),
		classicHistory: await wire.get(`/session/${sessionID}/message`),
		v2History: await wire.get(`/api/session/${sessionID}/message`),
	};
}

describe.skipIf(!RUN_EXPENSIVE)("OpenCode steer wire capture", () => {
	it("records a second prompt sent mid-tool through the v2 and classic calls", async () => {
		const directory = mkdtempSync(join(tmpdir(), "opencode-steer-work-"));
		const spawned = await spawnOpenCode({ timeoutMs: 60_000 });
		const recordings: OpenCodeRecording[] = [];
		const evidence: Record<string, unknown> = {
			ticket: "conduit-test-jyr9.8",
			at: new Date().toISOString(),
			opencodeUrl: spawned.url,
		};
		try {
			recordings.push(
				await recordScenario(
					spawned.url,
					directory,
					"v2-steer-during-tool",
					async (wire) => {
						const facts = await v2SecondPromptDuringTool(wire, "steer");
						// (c) The prompt call returns the new message's msg_ id.
						expect(facts.first.status).toBe(200);
						expect(facts.firstId).toMatch(/^msg_/);
						expect(facts.secondId).toMatch(/^msg_/);
						expect(facts.secondId > facts.firstId).toBe(true);
						// (a) session.next.prompted names each input by that id.
						expect(facts.firstPrompted).toBeGreaterThanOrEqual(0);
						expect(facts.secondPrompted).toBeGreaterThanOrEqual(0);
						// (b) The steer is admitted mid-tool and starts at the tool
						// boundary: after the tool result and its step's end,
						// before the next step of the same turn.
						expect(facts.secondAdmitted).toBeLessThan(facts.toolSuccess);
						expect(facts.toolSuccess).toBeLessThan(facts.secondPrompted);
						expect(facts.stepEnds[0]).toBeLessThan(facts.secondPrompted);
						expect(facts.stepStarts.length).toBeGreaterThanOrEqual(2);
						expect(facts.stepStarts[1]).toBeGreaterThan(facts.secondPrompted);
						// The v2 call runs OpenCode's v2 session engine: none of the
						// classic message/status events conduit ingests, and the
						// classic history stays empty.
						expect(facts.classicEvents).toEqual([]);
						expect(facts.classicHistory).toEqual([]);
						evidence["v2Steer"] = {
							sessionID: facts.sessionID,
							firstId: facts.firstId,
							secondId: facts.secondId,
							order: {
								secondAdmitted: facts.secondAdmitted,
								toolSuccess: facts.toolSuccess,
								firstStepEnded: facts.stepEnds[0],
								secondPrompted: facts.secondPrompted,
								nextStepStarted: facts.stepStarts[1],
							},
							classicEvents: facts.classicEvents.length,
							classicHistory: facts.classicHistory,
							v2History: facts.v2History,
						};
					},
				),
			);
			recordings.push(
				await recordScenario(
					spawned.url,
					directory,
					"v2-queue-during-tool",
					async (wire) => {
						const facts = await v2SecondPromptDuringTool(wire, "queue");
						expect(facts.secondId).toMatch(/^msg_/);
						// A queued input waits for the running turn to end: it
						// starts after the last step of the first turn.
						const firstTurnLastStepEnd = facts.stepEnds.filter(
							(i) => i < facts.secondPrompted,
						);
						expect(firstTurnLastStepEnd.length).toBeGreaterThanOrEqual(2);
						expect(facts.classicEvents).toEqual([]);
						evidence["v2Queue"] = {
							sessionID: facts.sessionID,
							secondId: facts.secondId,
							order: {
								secondAdmitted: facts.secondAdmitted,
								toolSuccess: facts.toolSuccess,
								stepEnds: facts.stepEnds,
								secondPrompted: facts.secondPrompted,
							},
						};
					},
				),
			);
			recordings.push(
				await recordScenario(
					spawned.url,
					directory,
					"classic-prompt-during-tool",
					async (wire) => {
						const session = await wire.post("/session", {
							title: "classic",
						});
						const sessionID = (session.body as { id: string }).id;
						const prompt = (text: string) =>
							wire.post(`/session/${sessionID}/prompt_async`, {
								parts: [{ type: "text", text }],
								model: { providerID: MODEL.providerID, modelID: MODEL.id },
							});
						const first = await prompt(TOOL_PROMPT);
						const toolRunning = (e: WireEvent) => {
							const part = e.properties["part"] as
								| {
										sessionID?: string;
										tool?: string;
										state?: { status?: string };
								  }
								| undefined;
							return (
								e.type === "message.part.updated" &&
								part?.sessionID === sessionID &&
								part.tool === "bash" &&
								part.state?.status === "running"
							);
						};
						await wire.waitFor("the bash tool to run", toolRunning);
						const second = await prompt(SECOND_PROMPT);
						await wire.waitFor(
							"session.idle",
							ofSession(sessionID, "session.idle"),
						);
						const { events } = wire;
						const userEchoes = events.flatMap((e, i) => {
							const info = e.properties["info"] as
								| { id?: string; role?: string; sessionID?: string }
								| undefined;
							return e.type === "message.updated" &&
								info?.role === "user" &&
								info.sessionID === sessionID
								? [{ index: i, id: info.id }]
								: [];
						});
						const echoIds = [...new Set(userEchoes.map((e) => e.id))];
						const secondEcho = userEchoes.find((e) => e.id === echoIds[1]);
						const toolCompleted = events.findIndex((e) => {
							const part = e.properties["part"] as
								| {
										sessionID?: string;
										tool?: string;
										state?: { status?: string };
								  }
								| undefined;
							return (
								e.type === "message.part.updated" &&
								part?.sessionID === sessionID &&
								part.tool === "bash" &&
								part.state?.status === "completed"
							);
						});
						// (c) prompt_async answers 204 with no body: no message id.
						expect(first.status).toBe(204);
						expect(second.status).toBe(204);
						expect(second.body).toBeUndefined();
						// (a) No per-input started signal on the classic path.
						expect(
							events.filter(
								(e) =>
									e.type.startsWith("session.next.") &&
									e.properties["sessionID"] === sessionID,
							),
						).toEqual([]);
						// The second user message is echoed at handoff, before
						// the running tool's result.
						expect(echoIds).toHaveLength(2);
						expect(secondEcho?.index).toBeLessThan(toolCompleted);
						evidence["classic"] = {
							sessionID,
							echoIds,
							secondEchoIndex: secondEcho?.index,
							toolCompletedIndex: toolCompleted,
						};
					},
				),
			);
			mkdirSync(FIXTURE_DIR, { recursive: true });
			for (const recording of recordings) {
				writeFileSync(
					join(FIXTURE_DIR, `${recording.name}.json`),
					`${JSON.stringify(recording, null, "\t")}\n`,
				);
			}
			evidence["captured"] = recordings.map((r) => r.name);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/jyr9-8-opencode-steer-capture.json",
				JSON.stringify(evidence, null, 2),
			);
			spawned.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 300_000);
});
