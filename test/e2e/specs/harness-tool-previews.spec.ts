// Tool previews on open, full detail on expand (conduit-test-y7eo.6), through
// the built server and the fake Claude SDK. What the browser receives is read
// off its /rpc socket: content that is the point arrives whole, long tool
// fields arrive as previews that carry their full size, and expanding a tool
// loads the rest, with a retry when that load fails. The tool-detail module
// (conduit-test-y7eo.10) keeps what was loaded: expanding again asks nothing,
// expands close together share one request, and a running tool's detail is
// never kept as final. Resting on a turn activity block for 2 s prefetches its
// tools' details in one request, once the session has loaded; scrolling past
// asks for nothing, and expanding a prefetched tool asks nothing
// (conduit-test-y7eo.11).
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts harness-tool-previews

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import type {
	EventPayloadMap,
	LiveEventType,
	ToolStartedPayload,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	endOf,
	LONG_ASSISTANT_TEXT,
	LONG_COMMAND,
	LONG_FILE_CONTENT,
	LONG_QUESTION,
	LONG_RESULT,
	LONG_SUBAGENT_OUTPUT,
	LONG_SUBAGENT_PROMPT,
	LONG_THINKING,
	LONG_USER_TEXT,
} from "../../fixtures/tool-previews.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const PREVIEW_CODE_POINTS = 2_000;
const SEEDED = "previews-seeded";
const BASH_ID = `${SEEDED}-bash`;
const TASK_ID = `${SEEDED}-task`;
const WRITE_ID = `${SEEDED}-write`;
const SEQ_IDS = [`${SEEDED}-seq-1`, `${SEEDED}-seq-2`] as const;
const PREFETCH = "prefetch-seeded";
/** Each turn's two finished tools with cut results. */
const TURN_TOOLS = [0, 1, 2].map((turn) =>
	[0, 1].map((i) => `${PREFETCH}-t${turn}-${i}`),
);
/** A reply taller than any screen, keeping turn activity blocks apart. */
const TALL_REPLY = Array.from(
	{ length: 80 },
	(_, i) => `Paragraph ${i} of a reply.`,
).join("\n\n");

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

const seed = (filename: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const at = Date.UTC(2026, 9, 1);
			const event = <T extends LiveEventType>(
				type: T,
				data: EventPayloadMap[T],
			) =>
				canonicalEvent(type, SEEDED, data, {
					provider: "claude",
					createdAt: at,
				});
			const user = `${SEEDED}-u`;
			const assistant = `${SEEDED}-a`;
			const thinking = {
				messageId: assistant,
				partId: `${assistant}-thinking`,
			};
			const tool = (
				partId: string,
				input: ToolStartedPayload["input"],
				result: string,
			) => [
				event("tool.started", {
					messageId: assistant,
					partId,
					toolName: input.tool,
					callId: partId,
					input,
				}),
				event("tool.running", { messageId: assistant, partId }),
				event("tool.completed", {
					messageId: assistant,
					partId,
					result,
					duration: 250,
				}),
			];
			yield* commit(
				[
					event("session.created", {
						sessionId: SEEDED,
						title: "Tool previews",
						provider: "claude",
						providerSessionId: SEEDED,
					}),
					event("message.created", {
						messageId: user,
						role: "user",
						sessionId: SEEDED,
					}),
					event("text.delta", {
						messageId: user,
						partId: `${user}-0`,
						text: LONG_USER_TEXT,
					}),
					event("message.created", {
						messageId: assistant,
						role: "assistant",
						sessionId: SEEDED,
					}),
					event("thinking.start", thinking),
					event("thinking.delta", { ...thinking, text: LONG_THINKING }),
					event("thinking.end", thinking),
					...tool(
						TASK_ID,
						{
							tool: "Task",
							description: "Explore the deploy scripts",
							prompt: LONG_SUBAGENT_PROMPT,
							subagentType: "explore",
						},
						LONG_SUBAGENT_OUTPUT,
					),
					...tool(
						WRITE_ID,
						{ tool: "Write", filePath: "notes.md", content: LONG_FILE_CONTENT },
						"File written",
					),
					...tool(
						BASH_ID,
						{ tool: "Bash", command: LONG_COMMAND },
						LONG_RESULT,
					),
					...SEQ_IDS.flatMap((id) =>
						tool(id, { tool: "Bash", command: "seq 1500" }, LONG_RESULT),
					),
					event("text.delta", {
						messageId: assistant,
						partId: `${assistant}-text`,
						text: LONG_ASSISTANT_TEXT,
					}),
					event("turn.completed", {
						messageId: assistant,
						tokens: { input: 10, output: 10 },
						duration: 1000,
					}),
				],
				{ publish: false },
			);
			// Three turns, each a block of two finished tools with cut results.
			// Every reply but the last is taller than a screen, so a block shows
			// alone and the newest is the one on screen at the bottom.
			const prefetchEvent = <T extends LiveEventType>(
				type: T,
				data: EventPayloadMap[T],
			) =>
				canonicalEvent(type, PREFETCH, data, {
					provider: "claude",
					createdAt: at,
				});
			yield* commit(
				[
					prefetchEvent("session.created", {
						sessionId: PREFETCH,
						title: "Prefetch",
						provider: "claude",
						providerSessionId: PREFETCH,
					}),
					...TURN_TOOLS.flatMap((ids, turn) => {
						const messageId = `${PREFETCH}-a${turn}`;
						return [
							prefetchEvent("message.created", {
								messageId: `${PREFETCH}-u${turn}`,
								role: "user",
								sessionId: PREFETCH,
							}),
							prefetchEvent("text.delta", {
								messageId: `${PREFETCH}-u${turn}`,
								partId: `${PREFETCH}-u${turn}-0`,
								text: `Turn ${turn}`,
							}),
							prefetchEvent("message.created", {
								messageId,
								role: "assistant",
								sessionId: PREFETCH,
							}),
							...ids.flatMap((partId) => [
								prefetchEvent("tool.started", {
									messageId,
									partId,
									toolName: "Bash",
									callId: partId,
									input: { tool: "Bash", command: "seq 1500" },
								}),
								prefetchEvent("tool.running", { messageId, partId }),
								prefetchEvent("tool.completed", {
									messageId,
									partId,
									result: LONG_RESULT,
									duration: 250,
								}),
							]),
							prefetchEvent("text.delta", {
								messageId,
								partId: `${messageId}-text`,
								text: turn < 2 ? TALL_REPLY : "Done.",
							}),
							prefetchEvent("turn.completed", {
								messageId,
								tokens: { input: 10, output: 10 },
								duration: 1000,
							}),
						];
					}),
				],
				{ publish: false },
			);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
		),
	);

interface Frame {
	readonly bytes: number;
	readonly value: unknown;
}

interface WireTool {
	readonly callID: string;
	readonly tool: string;
	readonly state?: {
		readonly status?: string;
		readonly input?: { readonly _tag: string; readonly value: unknown };
		readonly output?: { readonly _tag: string; readonly text: string };
	};
}

/** Every string anywhere in a frame. */
const strings = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: typeof value === "object" && value !== null
			? Object.values(value).flatMap(strings)
			: [];

const isTool = (value: object): value is WireTool =>
	"type" in value && value.type === "tool" && "callID" in value;

/** Every transcript tool part anywhere in a frame. */
const toolsIn = (value: unknown): WireTool[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap(toolsIn);
	return isTool(value) ? [value, ...nested] : nested;
};

const isSynchronized = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	value._tag === "synchronized";

/**
 * Records every frame the server sends the page and the tool ids of each
 * GetToolDetails request. Fails the next one once `failNextDetails` is set,
 * and holds them back from the server while `holdDetails` is set. While
 * `holdLoad` is set, a session's transcript arrives but the word that it has
 * finished loading (synchronized) waits for `releaseLoad`.
 */
const watchRpc = async (page: Page) => {
	const control = {
		frames: [] as Frame[],
		failNextDetails: false,
		holdDetails: false,
		held: [] as (() => void)[],
		detailRequests: [] as (readonly string[])[],
		holdLoad: false,
		heldLoad: [] as (() => void)[],
		release() {
			control.holdDetails = false;
			for (const send of control.held.splice(0)) send();
		},
		releaseLoad() {
			control.holdLoad = false;
			for (const send of control.heldLoad.splice(0)) send();
		},
	};
	const transcriptStreams = new Set<string>();
	await page.routeWebSocket(
		(url) => url.pathname === "/rpc",
		(socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const value: unknown = JSON.parse(message.toString());
				control.frames.push({ bytes: Buffer.byteLength(message), value });
				if (
					!control.holdLoad ||
					typeof value !== "object" ||
					value === null ||
					!("requestId" in value) ||
					!transcriptStreams.has(String(value.requestId)) ||
					!("values" in value) ||
					!Array.isArray(value.values) ||
					!value.values.some(isSynchronized)
				)
					return socket.send(message);
				const values: unknown[] = value.values;
				const rest = values.filter((item) => !isSynchronized(item));
				if (rest.length > 0)
					socket.send(JSON.stringify({ ...value, values: rest }));
				control.heldLoad.push(() =>
					socket.send(
						JSON.stringify({ ...value, values: values.filter(isSynchronized) }),
					),
				);
			});
			socket.onMessage((message) => {
				const sent: unknown = JSON.parse(message.toString());
				for (const item of [sent].flat())
					if (
						typeof item === "object" &&
						item !== null &&
						"tag" in item &&
						item.tag === "SubscribeSessionDetail" &&
						"id" in item
					)
						transcriptStreams.add(String(item.id));
				const request = [sent].flat().find(
					(
						item,
					): item is {
						tag: string;
						id: string;
						payload: { toolIds: readonly string[] };
					} =>
						typeof item === "object" &&
						item !== null &&
						"tag" in item &&
						item.tag === "GetToolDetails",
				);
				if (request) control.detailRequests.push(request.payload.toolIds);
				if (request && control.holdDetails)
					return control.held.push(() => server.send(message));
				if (!request || !control.failNextDetails) return server.send(message);
				control.failNextDetails = false;
				socket.send(
					JSON.stringify({
						_tag: "Exit",
						requestId: request.id,
						exit: {
							_tag: "Failure",
							cause: {
								_tag: "Fail",
								error: { _tag: "WsRpcError", message: "Injected failure" },
							},
						},
					}),
				);
			});
		},
	);
	return control;
};

const lastTool = (
	frames: readonly Frame[],
	match: (tool: WireTool) => boolean,
) =>
	frames
		.flatMap(({ value }) => toolsIn(value))
		.filter(match)
		.at(-1);

/** GetToolDetails replies: the only frames that carry tool details. */
const detailResponses = (frames: readonly Frame[]) =>
	frames.filter(({ value }) =>
		JSON.stringify(value).includes('"tools":[{"toolId"'),
	);

/** Open the turn's step log if it is closed, then the tool's row. */
const expandTool = async (page: Page, tool: Locator): Promise<Locator> => {
	if (!(await tool.isVisible()))
		await page.locator(".turn-activity-toggle").last().click();
	await tool.locator("button").first().click();
	return tool;
};

const toolRow = (page: Page, toolId: string) =>
	page.locator(`.tool-item[data-tool-id="${toolId}"]`);

test.describe.configure({ retries: 0 });
// The fake SDK holds the live tool until a release file beside its proof file.
test.use({ harnessOptions: { restartProof: true } });

test("tools open as previews and expand to full detail", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	await harness.terminate();
	await seed(harness.projectStorePath());
	await harness.restart({ keepPort: true });

	const driver = await harness.connect();
	await expect.poll(() => harness.generations.at(-1)?.fakeSdkActive).toBe(true);
	const send = (sessionId: string, text: string) =>
		Effect.runPromise(
			driver.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: driver.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text,
			}),
		);
	const questionSession = await driver.createSession("Long question");
	const toolSession = await driver.createSession("Long live tool");
	await send(questionSession, "question-long-options");

	const { viewport, isMobile, hasTouch } = testInfo.project.use;
	const context = await browser.newContext({
		...(viewport ? { viewport } : {}),
		...(isMobile === undefined ? {} : { isMobile }),
		...(hasTouch === undefined ? {} : { hasTouch }),
	});
	const page = await context.newPage();
	// Prefetch has its own test below. Here no turn activity block reports
	// itself on screen, so every detail request is an expand's.
	await page.addInitScript(() => {
		const Observer = window.IntersectionObserver;
		window.IntersectionObserver = class extends Observer {
			constructor(
				callback: IntersectionObserverCallback,
				options?: IntersectionObserverInit,
			) {
				super((entries, observer) => {
					const shown = entries.filter(
						({ target }) => !target.matches(".turn-activity"),
					);
					if (shown.length > 0) callback(shown, observer);
				}, options);
			}
		};
	});
	const rpc = await watchRpc(page);
	const app = new AppPage(page);

	// AC2: never-cut content arrives whole.
	await app.goto(`${harness.baseUrl}/s/${SEEDED}?p=process-test`);
	await expect(page.locator(".msg-user").last()).toContainText(endOf("user"));
	await expect(page.locator(".msg-assistant").last()).toContainText(
		endOf("assistant"),
	);
	const opened = rpc.frames.flatMap(({ value }) => strings(value));
	for (const whole of [LONG_USER_TEXT, LONG_THINKING, LONG_ASSISTANT_TEXT])
		expect(opened).toContain(whole);
	const task = lastTool(rpc.frames, ({ callID }) => callID === TASK_ID);
	expect(task?.state?.input).toEqual({
		_tag: "whole",
		value: expect.objectContaining({ prompt: LONG_SUBAGENT_PROMPT }),
	});
	expect(task?.state?.output).toEqual({
		_tag: "whole",
		text: LONG_SUBAGENT_OUTPUT,
	});
	await page.locator(".turn-activity-toggle").last().click();
	await page.locator(".thinking-item button").first().click();
	await expect(page.locator(".thinking-item").first()).toContainText(
		endOf("thinking"),
	);
	const taskRow = await expandTool(page, toolRow(page, TASK_ID));
	await expect(taskRow.locator(".tool-result")).toContainText(
		endOf("subagent-output"),
	);
	await expect(taskRow.locator(".tool-full-detail")).toHaveCount(0);

	// AC3: cut fields carry their full size; expanding loads the rest, and a
	// failed load offers a retry.
	const bash = lastTool(rpc.frames, ({ callID }) => callID === BASH_ID);
	expect(bash?.state?.input).toEqual({
		_tag: "preview",
		value: expect.objectContaining({
			command: [...LONG_COMMAND].slice(0, PREVIEW_CODE_POINTS).join(""),
		}),
		cuts: [{ path: ["command"], fullBytes: bytes(LONG_COMMAND) }],
	});
	expect(bash?.state?.output).toEqual({
		_tag: "preview",
		text: [...LONG_RESULT].slice(0, PREVIEW_CODE_POINTS).join(""),
		fullBytes: bytes(LONG_RESULT),
	});
	// A cut the card never shows (a written file's content) loads nothing.
	const write = lastTool(rpc.frames, ({ callID }) => callID === WRITE_ID);
	expect(write?.state?.input?._tag).toBe("preview");
	const writeRow = await expandTool(page, toolRow(page, WRITE_ID));
	await expect(writeRow.locator(".tool-result")).toContainText("File written");
	await expect(writeRow.locator(".tool-full-detail")).toHaveCount(0);
	expect(rpc.detailRequests).toHaveLength(0);

	const detailsBefore = detailResponses(rpc.frames).length;
	rpc.failNextDetails = true;
	const bashRow = await expandTool(page, toolRow(page, BASH_ID));
	await expect(bashRow).toContainText(
		"Couldn't load the full command and output.",
	);
	await expect(bashRow.locator(".tool-result")).not.toContainText(
		endOf("result"),
	);
	await bashRow.getByRole("button", { name: "Retry" }).click();
	await expect(bashRow.locator(".tool-result")).toContainText(endOf("result"));
	await expect(bashRow.locator(".tool-result")).toContainText(
		endOf("argument"),
	);
	await expect(bashRow.locator(".tool-full-detail")).toHaveCount(0);
	// The failed load and the retry: nothing else asked.
	expect(rpc.detailRequests).toHaveLength(2);
	const [detail] = detailResponses(rpc.frames).slice(detailsBefore);
	expect(detail).toBeDefined();

	// y7eo.10: expanding it again shows the whole tool and asks nothing.
	await bashRow.locator("button").first().click();
	await expect(bashRow.locator(".tool-result")).toHaveCount(0);
	await bashRow.locator("button").first().click();
	await expect(bashRow.locator(".tool-result")).toContainText(endOf("result"));
	await expect(bashRow.locator(".tool-full-detail")).toHaveCount(0);
	expect(rpc.detailRequests).toHaveLength(2);

	// Expands close together share one request, and expanding a tool whose
	// load is on its way joins it.
	rpc.holdDetails = true;
	await page.evaluate((ids) => {
		for (const id of ids)
			document
				.querySelector<HTMLElement>(`.tool-item[data-tool-id="${id}"] button`)
				?.click();
	}, SEQ_IDS);
	const seqRow = toolRow(page, SEQ_IDS[0]);
	await expect(seqRow).toContainText("Loading full output…");
	await seqRow.locator("button").first().click();
	await expect(seqRow.locator(".tool-full-detail")).toHaveCount(0);
	await seqRow.locator("button").first().click();
	await expect(seqRow).toContainText("Loading full output…");
	rpc.release();
	for (const id of SEQ_IDS)
		await expect(toolRow(page, id).locator(".tool-result")).toContainText(
			endOf("result"),
		);
	expect(rpc.detailRequests.slice(2)).toEqual([SEQ_IDS]);

	// AC2: a pending question with over 2,000 characters of options, whole.
	await app.goto(`${harness.baseUrl}/s/${questionSession}?p=process-test`);
	const card = page.locator(".question-card").last();
	for (const option of LONG_QUESTION.questions[0]?.options ?? [])
		await expect(card).toContainText(option.description);
	expect(
		JSON.stringify(LONG_QUESTION.questions[0]?.options).length,
	).toBeGreaterThan(PREVIEW_CODE_POINTS);
	const question = lastTool(rpc.frames, ({ tool }) =>
		["AskUserQuestion", "question"].includes(tool),
	);
	expect(question?.state?.input).toEqual({
		_tag: "whole",
		value: expect.objectContaining({ questions: LONG_QUESTION.questions }),
	});

	// AC4: a long live result arrives as a preview, and the final result
	// replaces the running tool.
	await app.goto(`${harness.baseUrl}/s/${toolSession}?p=process-test`);
	await expect(app.input).toBeVisible();
	const liveFrom = rpc.frames.length;
	await send(toolSession, "tool-long-live");
	const liveBash = () =>
		lastTool(rpc.frames.slice(liveFrom), ({ tool }) => tool === "Bash");
	await expect.poll(() => liveBash()?.state?.status).toBe("running");
	expect(liveBash()?.state?.input?._tag).toBe("preview");
	expect(liveBash()?.state?.output).toBeUndefined();
	// y7eo.10: a running tool's detail loads, but is never kept as final, even
	// though the browser already shows the tool as completed.
	const liveId = liveBash()?.callID ?? "missing";
	const requestsBeforeLive = rpc.detailRequests.length;
	const runningRow = await expandTool(page, toolRow(page, liveId));
	await expect(runningRow.locator(".tool-result")).toContainText(
		endOf("argument"),
	);
	expect(rpc.detailRequests.slice(requestsBeforeLive)).toEqual([[liveId]]);
	writeFileSync(join(harness.root, "release-tool-long"), "release");
	await expect.poll(() => liveBash()?.state?.status).toBe("completed");
	expect(liveBash()?.state?.output).toEqual({
		_tag: "preview",
		text: [...LONG_RESULT].slice(0, PREVIEW_CODE_POINTS).join(""),
		fullBytes: bytes(LONG_RESULT),
	});
	const liveUpdates = rpc.frames
		.slice(liveFrom)
		.filter(({ value }) => toolsIn(value).some(({ tool }) => tool === "Bash"));
	// The finished turn folds its step log; open it after that, not before.
	await expect(page.locator(".turn-activity-toggle").last()).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	const liveRow = await expandTool(page, toolRow(page, liveId));
	await expect(liveRow.locator(".tool-result")).toContainText(endOf("result"));
	// The settled tool's detail was asked for once more, then kept.
	expect(rpc.detailRequests.slice(requestsBeforeLive)).toEqual([
		[liveId],
		[liveId],
	]);
	await liveRow.locator("button").first().click();
	await expect(liveRow.locator(".tool-result")).toHaveCount(0);
	await liveRow.locator("button").first().click();
	await expect(liveRow.locator(".tool-result")).toContainText(endOf("result"));
	expect(rpc.detailRequests.slice(requestsBeforeLive)).toHaveLength(2);

	// The artifact: what each kind of frame cost, in bytes.
	const report = {
		project: testInfo.project.name,
		seededDetailResponseBytes: detail?.bytes,
		liveToolUpdateBytes: liveUpdates.map((frame) => frame.bytes),
		fullBytes: { command: bytes(LONG_COMMAND), result: bytes(LONG_RESULT) },
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`tool-previews.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("tool-previews-report", { path: output });
	// A live update carries previews, never the whole result.
	for (const frame of liveUpdates)
		expect(frame.bytes).toBeLessThan(bytes(LONG_RESULT));
	await context.close();
	await driver.close();
});

test("resting on a turn activity block prefetches its tools, once loaded", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	await harness.terminate();
	await seed(harness.projectStorePath());
	await harness.restart({ keepPort: true });

	const { viewport, isMobile, hasTouch } = testInfo.project.use;
	const context = await browser.newContext({
		...(viewport ? { viewport } : {}),
		...(isMobile === undefined ? {} : { isMobile }),
		...(hasTouch === undefined ? {} : { hasTouch }),
	});
	const page = await context.newPage();
	const rpc = await watchRpc(page);
	const app = new AppPage(page);
	const blocks = page.locator(".turn-activity");
	/** Let a block rest on screen well past 2 s. */
	const rest = () => page.waitForTimeout(3_000);
	const [, middle = [], newest = []] = TURN_TOOLS;

	// None before the session's initial load completes: the transcript is on
	// screen, but the word that it has loaded is held back.
	rpc.holdLoad = true;
	await app.goto(`${harness.baseUrl}/s/${PREFETCH}?p=process-test`);
	await expect(blocks).toHaveCount(3);
	await expect(blocks.last()).toBeInViewport();
	await expect(blocks.nth(1)).not.toBeInViewport();
	await rest();
	expect(rpc.detailRequests).toEqual([]);
	rpc.releaseLoad();
	await expect.poll(() => rpc.detailRequests).toEqual([newest]);

	// Resting on a block for 2 s: exactly one batched request, for its tools.
	await blocks.nth(1).scrollIntoViewIfNeeded();
	await expect(blocks.last()).not.toBeInViewport();
	await expect.poll(() => rpc.detailRequests).toEqual([newest, middle]);
	await rest();
	expect(rpc.detailRequests).toEqual([newest, middle]);

	// Scrolling past a block within 1 s asks for nothing; the one scrolled
	// back to is already loaded.
	await page.evaluate(async () => {
		const [first, second] = document.querySelectorAll(".turn-activity");
		first?.scrollIntoView({ block: "center" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		second?.scrollIntoView({ block: "center" });
	});
	await expect(blocks.first()).not.toBeInViewport();
	await rest();
	expect(rpc.detailRequests).toEqual([newest, middle]);

	// Expanding a prefetched tool shows it whole and asks nothing.
	await blocks.nth(1).locator(".turn-activity-toggle").click();
	const row = await expandTool(page, toolRow(page, middle[0] ?? "missing"));
	await expect(row.locator(".tool-result")).toContainText(endOf("result"));
	await expect(row.locator(".tool-full-detail")).toHaveCount(0);
	expect(rpc.detailRequests).toEqual([newest, middle]);

	// A tool that finishes while its block stays on screen is prefetched once
	// it has: its block rested while it ran.
	const driver = await harness.connect();
	await expect.poll(() => harness.generations.at(-1)?.fakeSdkActive).toBe(true);
	const liveSession = await driver.createSession("Live prefetch");
	await app.goto(`${harness.baseUrl}/s/${liveSession}?p=process-test`);
	await expect(app.input).toBeVisible();
	const liveFrom = rpc.frames.length;
	const requestsBeforeLive = rpc.detailRequests.length;
	await Effect.runPromise(
		driver.rpc.input.submit({
			projectSlug: "process-test",
			sessionId: liveSession,
			originId: driver.originId,
			inputId: randomUUID(),
			delivery: "queue",
			text: "tool-long-live",
		}),
	);
	const liveBash = () =>
		lastTool(rpc.frames.slice(liveFrom), ({ tool }) => tool === "Bash");
	await expect.poll(() => liveBash()?.state?.status).toBe("running");
	await expect(blocks.last()).toBeInViewport();
	await rest();
	writeFileSync(join(harness.root, "release-tool-long"), "release");
	await expect.poll(() => liveBash()?.state?.status).toBe("completed");
	const liveId = liveBash()?.callID ?? "missing";
	await rest();
	expect(rpc.detailRequests.slice(requestsBeforeLive).at(-1)).toEqual([liveId]);
	await expect(blocks.last().locator(".turn-activity-toggle")).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	const requestsAfterLive = rpc.detailRequests.length;
	const liveRow = await expandTool(page, toolRow(page, liveId));
	await expect(liveRow.locator(".tool-result")).toContainText(endOf("result"));
	expect(rpc.detailRequests).toHaveLength(requestsAfterLive);
	await driver.close();
	await context.close();
});
