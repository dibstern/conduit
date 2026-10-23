// conduit-test-mebm: hiding and then showing the step log of a very long turn
// must not remount its rows, which made showing it slow. Asserts that rows and
// their own open state survive a hide and show, on a settled and a live turn of
// STEPS steps. Also times click → next paint on the built frontend under a
// mid-tier device's 4x CPU throttle (STEP_LOG_THROTTLE overrides it) and writes
// the numbers to step-log-toggle.json in the test output; STEP_LOG_PERF_ASSERT=1
// asserts them too. STEP_LOG_PROFILE=1 also writes a Chrome trace and a CPU
// profile of the first show and of a later show.

import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const SESSION = "sess-step-log-perf";
const STEPS = 320;
const RUNS = 7;
// Showing a hidden log, 4x throttled: about 240 ms when it remounted every
// row, about 115 ms once the rows stay mounted. Only with STEP_LOG_PERF_ASSERT=1.
const RESHOW_MEDIAN_MS = 160;

const TOOLS: readonly [string, (i: number) => Record<string, unknown>][] = [
	[
		"Bash",
		(i) => ({
			command: `pnpm vitest run test/unit/module-${i}.test.ts --reporter dot`,
		}),
	],
	[
		"Read",
		(i) => ({
			file_path: `src/lib/frontend/components/chat/module-${i}.svelte`,
		}),
	],
	[
		"Edit",
		(i) => ({
			file_path: `src/lib/module-${i}.ts`,
			old_string: `const a${i} = 1;`,
			new_string: `const a${i} = 2;`,
		}),
	],
	["Grep", (i) => ({ pattern: `handler${i}|route${i}`, path: "src/lib" })],
	["Glob", (i) => ({ pattern: `src/**/module-${i}*.ts` })],
	[
		"Write",
		(i) => ({
			file_path: `docs/notes-${i}.md`,
			content: `# Note ${i}\n\nBody.`,
		}),
	],
	[
		"WebFetch",
		(i) => ({ url: `https://example.com/docs/${i}`, prompt: "Summarise" }),
	],
];

/** One turn of `steps` steps: mostly tools of every kind, some thinking and some interim text. */
function turnEvents(prefix: string, steps: number): MockMessage[] {
	const events: MockMessage[] = [];
	for (let i = 0; i < steps; i++) {
		const messageId = `${prefix}-m${i}`;
		if (i % 10 === 4) {
			const partId = `${prefix}-think-${i}`;
			events.push({ type: "thinking_start", messageId, partId });
			events.push({
				type: "thinking_delta",
				messageId,
				partId,
				text: `Step ${i}: the failing check points at the pool config, so read it next and compare with the retry code.`,
			});
			continue;
		}
		if (i % 15 === 7 && i < steps - 1) {
			events.push({
				type: "delta",
				messageId,
				partId: `${prefix}-text-${i}`,
				text: `Checked **${i}** modules so far. The \`retry\` path still needs a look:\n\n- pool size\n- backoff`,
			});
			continue;
		}
		const [name, input] = TOOLS[i % TOOLS.length] ?? ["Bash", () => ({})];
		const id = `${prefix}-call-${i}`;
		events.push({ type: "tool_start", messageId, id, name });
		events.push({
			type: "tool_executing",
			messageId,
			id,
			name,
			input: input(i),
		});
		events.push({
			type: "tool_result",
			messageId,
			id,
			content: `${name} ${i} ok\n`.repeat(3),
			is_error: i % 25 === 0,
		});
	}
	return events;
}

function initMessages(): MockMessage[] {
	return [
		{
			type: "mock_transcript_snapshot",
			id: SESSION,
			events: [
				{ type: "user_message", text: "Audit every module" },
				...turnEvents("settled", STEPS),
				{
					type: "delta",
					messageId: "settled-reply",
					text: "All modules audited.",
				},
				{ type: "done", code: 0 },
			],
		},
		{ type: "status", status: "idle" },
		{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
		{ type: "client_count", count: 1 },
		{
			type: "shell_snapshot",
			roots: true,
			sessions: [
				{
					id: SESSION,
					title: "Step log perf",
					status: "idle",
					updatedAt: Date.now(),
					messageCount: 2,
				},
			],
		},
		{
			type: "mock_model_catalog",
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{
							id: "claude-sonnet-4",
							name: "claude-sonnet-4",
							provider: "anthropic",
						},
					],
				},
			],
		},
	];
}

/** Click the toggle in the page and time it to the frame after the next paint. */
function clickToPaint(toggle: Locator): Promise<number> {
	return toggle.evaluate(async (el) => {
		const start = performance.now();
		(el as HTMLElement).click();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		return performance.now() - start;
	});
}

async function settle(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				setTimeout(() => requestAnimationFrame(() => resolve()), 150),
			),
	);
}

const shownRows = (turn: Locator) => turn.locator("[data-log-part]:visible");

type Timed = (name: string, click: () => Promise<number>) => Promise<number>;

/** The first show mounts the log; the runs after it hide and show it again. */
async function measure(
	page: Page,
	turn: Locator,
	hiddenRows: number,
	timed: Timed,
) {
	const toggle = turn.locator(".turn-activity-toggle");
	const click = () => clickToPaint(toggle);
	const toggleTo = async (name: string, shown: boolean) => {
		const ms = await timed(name, click);
		await expect(toggle).toHaveAttribute("aria-expanded", String(shown));
		await expect(shownRows(turn)).toHaveCount(shown ? STEPS : hiddenRows);
		await settle(page);
		return ms;
	};
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	const firstShow = await toggleTo("first-show", true);
	await toggleTo("first-hide", false);
	const show: number[] = [];
	const hide: number[] = [];
	for (let run = 0; run < RUNS; run++) {
		show.push(await toggleTo(`show-${run}`, true));
		hide.push(await toggleTo(`hide-${run}`, false));
	}
	const stats = (samples: number[]) => {
		const sorted = [...samples].sort((a, b) => a - b);
		return {
			median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
			max: Math.round(sorted.at(-1) ?? 0),
			samples: samples.map(Math.round),
		};
	};
	return {
		firstShow: Math.round(firstShow),
		show: stats(show),
		hide: stats(hide),
	};
}

/** Hiding and showing the log keeps its row elements, and a row's own open state. */
async function expectRowsKept(turn: Locator) {
	const toggle = turn.locator(".turn-activity-toggle");
	const rows = turn.locator("[data-log-part]");
	const firstRowToggle = rows.first().locator("[aria-expanded]").first();
	const toggleTo = async (shown: boolean) => {
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", String(shown));
	};
	await toggleTo(true);
	await firstRowToggle.click();
	await expect(firstRowToggle).toHaveAttribute("aria-expanded", "true");
	// The first row is hidden with the log; the last stays in view as the ticker of a live turn.
	for (const row of [rows.first(), rows.last()])
		await row.evaluate((el) => {
			(el as HTMLElement).dataset["probe"] = "kept";
		});
	await toggleTo(false);
	await toggleTo(true);
	await expect(rows.first(), "first row element").toHaveAttribute(
		"data-probe",
		"kept",
	);
	await expect(rows.last(), "last row element").toHaveAttribute(
		"data-probe",
		"kept",
	);
	await expect(firstRowToggle, "first row stays open").toHaveAttribute(
		"aria-expanded",
		"true",
	);
}

/** Records a Chrome trace and a CPU profile of the first show and of one show after a hide. */
function profiled(
	page: Page,
	prefix: string,
	outputPath: (file: string) => string,
): Timed {
	return async (name, click) => {
		if (name !== "first-show" && name !== "show-0") return click();
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
		const events: unknown[] = [];
		cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
		const done = new Promise<void>((resolve) =>
			cdp.once("Tracing.tracingComplete", () => resolve()),
		);
		await cdp.send("Tracing.start", {
			categories:
				"devtools.timeline,disabled-by-default-devtools.timeline,v8.execute",
			transferMode: "ReportEvents",
		});
		await cdp.send("Profiler.start");
		const ms = await click();
		const { profile } = await cdp.send("Profiler.stop");
		await cdp.send("Tracing.end");
		await done;
		await cdp.detach();
		writeFileSync(
			outputPath(`${prefix}-${name}.cpuprofile`),
			JSON.stringify(profile),
		);
		writeFileSync(
			outputPath(`${prefix}-${name}.trace.json`),
			JSON.stringify({ traceEvents: events }),
		);
		return ms;
	};
}

test.describe("Step log toggle performance", () => {
	test.describe.configure({ timeout: 120_000, retries: 0 });
	test.use({ viewport: { width: 1440, height: 900 } });

	test(`hiding and then showing a ${STEPS}-step log keeps its rows`, async ({
		page,
		relayUrl,
	}, testInfo) => {
		const wsMock = await mockRelayWebSocket(page, {
			initMessages: initMessages(),
			responses: new Map(),
		});
		await page.goto(new URL(`/s/${SESSION}`, relayUrl).href);
		await page
			.locator("#connect-overlay")
			.waitFor({ state: "hidden", timeout: 15_000 });

		const turns = page.locator("#messages .turn-activity");
		const settled = turns.first();
		await expect(settled.locator(".turn-activity-toggle")).toContainText(
			"Worked",
		);
		// The transcript can still re-render right after it loads, detaching the toggle.
		await expect(() =>
			settled
				.locator(".turn-activity-toggle")
				.scrollIntoViewIfNeeded({ timeout: 1000 }),
		).toPass();
		await settle(page);
		const throttle = Number(process.env["STEP_LOG_THROTTLE"] ?? 4);
		if (throttle > 1)
			await (await page.context().newCDPSession(page)).send(
				"Emulation.setCPUThrottlingRate",
				{ rate: throttle },
			);
		const profiling = process.env["STEP_LOG_PROFILE"] === "1";
		const timed = (prefix: string): Timed =>
			profiling
				? profiled(page, prefix, (file) => testInfo.outputPath(file))
				: (_name, click) => click();
		const settledTimes = await measure(page, settled, 0, timed("settled"));

		// A live turn with no reply yet shows its newest steps as a ticker.
		wsMock.sendMessage({ type: "user_message", text: "Audit them again" });
		wsMock.sendMessage({ type: "status", status: "processing" });
		for (const event of turnEvents("live", STEPS)) wsMock.sendMessage(event);
		const live = page.locator(
			'#messages .turn-activity:has([data-testid="turn-live-head"])',
		);
		await expect(live.locator("[data-log-part]").last()).toContainText(
			`${STEPS - 1}`,
		);
		await live.locator(".turn-activity-toggle").scrollIntoViewIfNeeded();
		await settle(page);
		const liveTimes = await measure(page, live, 3, timed("live"));

		const result = {
			steps: STEPS,
			runs: RUNS,
			cpuThrottle: throttle,
			settled: settledTimes,
			live: liveTimes,
		};
		const file = testInfo.outputPath("step-log-toggle.json");
		writeFileSync(file, `${JSON.stringify(result, null, "\t")}\n`);
		console.log(
			`step-log-toggle: ${file}\n${JSON.stringify({ settled: settledTimes, live: liveTimes })}`,
		);

		// Checked after timing both turns, so an open row doesn't skew the numbers.
		await expectRowsKept(settled);
		await expectRowsKept(live);

		if (
			process.env["STEP_LOG_PERF_ASSERT"] === "1" &&
			!profiling &&
			throttle === 4
		)
			for (const [name, times] of Object.entries({
				settled: settledTimes,
				live: liveTimes,
			}))
				expect(times.show.median, `${name} re-show median (ms)`).toBeLessThan(
					RESHOW_MEDIAN_MS,
				);

		wsMock.sendMessage({ type: "done", code: 0 });
	});
});
