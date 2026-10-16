import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { CursorSendOptions } from "../../../src/lib/provider/cursor/sdk-port.js";

const runLive =
	process.env["RUN_CURSOR_LIVE_SMOKE"] === "1" &&
	Boolean(process.env["CURSOR_API_KEY"]);

describe.skipIf(!runLive)("Cursor in-process runner live smoke", () => {
	it(
		"records Composer 2.5 with fast off, plus Grok thinking only if needed",
		{ timeout: 240_000 },
		async () => {
			const resultsRoot = resolve("test-results/xqsg-5-cursor-live");
			mkdirSync(resultsRoot, { recursive: true });
			const root = mkdtempSync(join(resultsRoot, "run-"));
			const workspaceRoot = join(root, "workspace");
			const daemonConfigDir = join(root, "config");
			const cursorDataDir = join(daemonConfigDir, "cursor-data");
			for (const directory of [workspaceRoot, cursorDataDir]) {
				mkdirSync(directory, { recursive: true });
			}
			const previousDataDir = process.env["CURSOR_DATA_DIR"];
			process.env["CURSOR_DATA_DIR"] = cursorDataDir;
			const evidence: {
				ticket: string;
				at: string;
				runner: string;
				complete: boolean;
				thinkingModel: string | null;
				recordings: Array<{
					model: string;
					trace: string;
					status: string;
					eventCounts: Record<string, number>;
					text: string;
					thinkingCharacters: number;
					closedBeforeStoreDisposed: boolean;
				}>;
			} = {
				ticket: "conduit-test-xqsg.5",
				at: new Date().toISOString(),
				runner: "in-process",
				complete: false,
				thinkingModel: null,
				recordings: [],
			};
			try {
				// The SDK reads its transcript root when loaded. Isolate it first.
				const { makeCursorSessionRunner } = await import(
					"../../../src/lib/provider/cursor/cursor-runner-payload.js"
				);
				const { createRealCursorSdkPort } = await import(
					"../../../src/lib/provider/cursor/sdk-real.js"
				);
				const { teeCursorSdkPort } = await import(
					"../../../src/lib/provider/cursor/sdk-trace.js"
				);
				for (const modelId of ["composer-2.5", "grok-4.6"]) {
					const tracePath = join(root, `${modelId}.jsonl`);
					const model: CursorSendOptions["model"] = {
						id: modelId,
						...(modelId === "composer-2.5"
							? { params: [{ id: "fast", value: "false" }] }
							: {}),
					};
					const port = teeCursorSdkPort(createRealCursorSdkPort(), tracePath, {
						scenario: "cursor-runner-live-smoke",
						model,
					});
					const events: ProviderRuntimeEvent[] = [];
					let interactions = 0;
					const result = await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const runner = yield* makeCursorSessionRunner(
									{ workspaceRoot, daemonConfigDir, port },
									(output) =>
										Effect.sync(() => {
											if (output.type === "event") events.push(output.event);
											if (
												output.type === "permission-request" ||
												output.type === "question-request"
											)
												interactions++;
											return {};
										}),
								);
								const sessionId = `cursor-live-${modelId}`;
								const completed = yield* runner
									.executeEffect({
										type: "send-turn",
										sinkId: `sink-${modelId}`,
										aborted: false,
										input: {
											inputId: `input-${modelId}`,
											sessionId,
											prompt:
												"Do not call tools or create subagents. Think briefly about 17 times 19, then reply with exactly CURSOR_LIVE_SMOKE_OK.",
											history: [],
											providerState: {},
											workspaceRoot,
											extraFolders: [],
											permissionMode: "full",
											model: { providerId: "cursor", modelId },
										},
									})
									.pipe(Effect.timeout("100 seconds"));
								yield* runner.executeEffect({ type: "end-session", sessionId });
								return completed;
							}),
						),
					);
					const eventCounts: Record<string, number> = {};
					let text = "";
					let thinkingCharacters = 0;
					for (const event of events) {
						eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
						const data = event.data;
						if (
							typeof data === "object" &&
							data !== null &&
							"text" in data &&
							typeof data.text === "string"
						) {
							if (event.type === "text.delta") text += data.text;
							if (event.type === "thinking.delta") {
								thinkingCharacters += data.text.length;
							}
						}
					}
					const rows = readFileSync(tracePath, "utf8")
						.trim()
						.split("\n")
						.map(
							(line) => JSON.parse(line) as { kind?: string; data?: unknown },
						);
					const closed = rows.findIndex((row) => row.kind === "agent.disposed");
					const disposed = rows.findIndex(
						(row) => row.kind === "store.disposed",
					);
					const closedBeforeStoreDisposed = closed >= 0 && disposed > closed;
					evidence.recordings.push({
						model: modelId,
						trace: relative(resolve("."), tracePath),
						status: result.status,
						eventCounts,
						text,
						thinkingCharacters,
						closedBeforeStoreDisposed,
					});
					expect(result.status).toBe("completed");
					expect(text).toContain("CURSOR_LIVE_SMOKE_OK");
					expect(eventCounts["turn.completed"]).toBe(1);
					expect(eventCounts["turn.error"] ?? 0).toBe(0);
					expect(interactions).toBe(0);
					expect(closedBeforeStoreDisposed).toBe(true);
					expect(
						rows.find((row) => row.kind === "send.options")?.data,
					).toMatchObject({
						options: { model, mode: "agent" },
					});
					if (thinkingCharacters > 0) {
						evidence.thinkingModel = modelId;
						break;
					}
				}
				expect(evidence.thinkingModel).not.toBeNull();
				evidence.complete = true;
			} finally {
				if (previousDataDir === undefined)
					delete process.env["CURSOR_DATA_DIR"];
				else process.env["CURSOR_DATA_DIR"] = previousDataDir;
				writeFileSync(
					join(root, "evidence.json"),
					JSON.stringify(evidence, null, 2),
				);
			}
		},
	);
});
