import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const TRACE = "concurrent-background-work-turn";
const HOLD_MS = 8_000;
// fmtDuration floors seconds; the wall-clock measurement also includes the
// send click and the final DOM update. One second covers display quantization
// without hiding an eight-second idle gap. Stored-stamp checks use the same cap.
const TOLERANCE_MS = 1_000;

type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};
type TraceLine = {
	type: string;
	parent_tool_use_id?: string | null;
	message?: { usage?: Usage };
	usage?: Usage;
	modelUsage?: Record<string, { contextWindow: number }>;
};
const results: {
	sdkUsage: Usage;
	contextUsage: Usage;
	contextWindow: number;
}[] = [];
let lastRequest: Usage | undefined;
for (const line of readFileSync(
	join(process.cwd(), "test/fixtures/claude-sdk-traces", `${TRACE}.jsonl`),
	"utf8",
)
	.trim()
	.split("\n")) {
	const event = JSON.parse(line) as TraceLine;
	if (event.type === "assistant" && !event.parent_tool_use_id)
		lastRequest = event.message?.usage;
	if (event.type !== "result") continue;
	if (!event.usage) throw new Error("trace result has no usage");
	results.push({
		sdkUsage: event.usage,
		contextUsage: lastRequest ?? event.usage,
		contextWindow: Math.max(
			...Object.values(event.modelUsage ?? {}).map(
				(model) => model.contextWindow,
			),
		),
	});
	lastRequest = undefined;
}
const sdkTokens = results.reduce(
	(sum, result) => ({
		input: sum.input + result.sdkUsage.input_tokens,
		output: sum.output + result.sdkUsage.output_tokens,
	}),
	{ input: 0, output: 0 },
);
const last = results.at(-1);
if (!last) throw new Error("trace has no results");
const contextUsed =
	last.contextUsage.input_tokens +
	last.contextUsage.cache_read_input_tokens +
	last.contextUsage.cache_creation_input_tokens;
const contextPct = Math.min(
	100,
	Math.round((contextUsed / last.contextWindow) * 100),
);

test.describe("Claude turn working time", () => {
	test.use({
		claudeReplay: { turns: [TRACE], holdAfterResult: true, delayMs: 10 },
	});

	test("excludes the held wake-up gap and totals the turn's tokens", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		const parentId = decodeURIComponent(harness.projectUrl.slice("/s/".length));
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const stamps = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const prompt = db
					.prepare(
						"SELECT created_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at LIMIT 1",
					)
					.get(parentId);
				if (!prompt) throw new Error("parent prompt has not been stored");
				const startedAt = Number(prompt["created_at"]);
				const events = db
					.prepare(
						"SELECT type, data, created_at FROM events WHERE session_id = ? AND type IN ('message.created', 'tool.started', 'thinking.delta', 'text.delta', 'turn.completed') ORDER BY sequence",
					)
					.all(parentId);
				const segments: {
					firstEventAt: number;
					endAt: number;
					contextTokens?: number;
					tokens: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						contextWindow?: number;
					};
				}[] = [];
				let firstEventAt: number | undefined;
				for (const event of events) {
					firstEventAt ??= Number(event["created_at"]);
					if (event["type"] !== "turn.completed") continue;
					const data = JSON.parse(String(event["data"])) as {
						tokens: (typeof segments)[number]["tokens"];
						contextTokens?: number;
					};
					segments.push({
						firstEventAt,
						endAt: Number(event["created_at"]),
						tokens: data.tokens,
						...(data.contextTokens === undefined
							? {}
							: { contextTokens: data.contextTokens }),
					});
					firstEventAt = undefined;
				}
				const gaps = segments.slice(1).map((segment, index) => ({
					from: segments[index]?.endAt ?? segment.firstEventAt,
					to: segment.firstEventAt,
				}));
				const gapMs = gaps.reduce(
					(sum, gap) => sum + Math.max(0, gap.to - gap.from),
					0,
				);
				return {
					startedAt,
					segments,
					gaps,
					gapMs,
					workingMs: (segments.at(-1)?.endAt ?? startedAt) - startedAt - gapMs,
				};
			} finally {
				db.close();
			}
		};
		const report: Record<string, unknown> = {
			trace: TRACE,
			sdkTokens,
			contextUsed,
			contextPct,
			results,
			toleranceMs: TOLERANCE_MS,
		};
		try {
			await page.addInitScript(() => {
				localStorage.setItem(
					"conduit-composer-preferences",
					JSON.stringify({ controls: "words" }),
				);
			});
			await app.goto(relayUrl);
			const sentAt = performance.now();
			await app.sendMessage("Launch the background work");
			await replayer.held();
			await expect.poll(() => stamps().segments.length).toBe(1);
			const heldAt = performance.now();
			await delay(HOLD_MS);
			const heldMs = performance.now() - heldAt;
			report["heldMs"] = heldMs;
			report["held"] = stamps();
			replayer.release();
			await expect
				.poll(() => chat.getLastAssistantText())
				.toContain("The top-level 40-second shell finished.");
			await expect.poll(() => stamps().segments.length).toBe(results.length);
			await chat.waitForStreamingComplete();
			const wallMs = performance.now() - sentAt;
			const final = stamps();
			const meta = page.locator(".turn-meta").last();
			const duration = page.locator(".turn-duration").last();
			await expect(meta).toBeVisible();
			await expect(duration).toBeVisible();
			const shownDuration = (await duration.innerText()).trim();
			const units = [...shownDuration.matchAll(/(\d+)(ms|m|s)/g)];
			if (!units.length)
				throw new Error(`unrecognized settled duration: ${shownDuration}`);
			const shownMs = units.reduce(
				(sum, match) =>
					sum +
					Number(match[1]) *
						(match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1),
				0,
			);
			const shownTokens = {
				input: await meta
					.getByTitle("Fresh input tokens", { exact: true })
					.innerText(),
				output: await meta
					.getByTitle("Output tokens", { exact: true })
					.innerText(),
			};
			const storedTokens = final.segments.reduce(
				(sum, segment) => ({
					input: sum.input + (segment.tokens.input ?? 0),
					output: sum.output + (segment.tokens.output ?? 0),
				}),
				{ input: 0, output: 0 },
			);
			const context = meta.locator(
				'[title$="tokens in context when this turn finished"]',
			);
			report["final"] = {
				...final,
				wallMs,
				shownDuration,
				shownMs,
				shownTokens,
				storedTokens,
				shownContext: await context.innerText(),
				contextTitle: await context.getAttribute("title"),
			};
			expect(final.segments).toHaveLength(results.length);
			expect(final.gaps).toHaveLength(results.length - 1);
			const firstGap = final.gaps[0];
			if (!firstGap) throw new Error("no wake-up gap was stored");
			expect(firstGap.to - firstGap.from).toBeGreaterThanOrEqual(heldMs);
			expect(shownMs).toBeLessThan(wallMs - heldMs + TOLERANCE_MS);
			expect(Math.abs(shownMs - final.workingMs)).toBeLessThan(TOLERANCE_MS);
			expect(shownTokens).toEqual({
				input: `${storedTokens.input} in`,
				output: `${storedTokens.output} out`,
			});
			await expect(context).toContainText(`${contextPct}%`);
			await expect(context).toHaveAttribute(
				"title",
				`${Math.round(contextUsed / 1_000)}k of ${(last.contextWindow / 1_000_000).toFixed(1)}M tokens in context when this turn finished`,
			);
			expect(shownTokens).toEqual({
				input: `${sdkTokens.input} in`,
				output: `${sdkTokens.output} out`,
			});
			expect(final.segments.map((segment) => segment.contextTokens)).toEqual(
				results.map(
					(result) =>
						result.contextUsage.input_tokens +
						result.contextUsage.cache_read_input_tokens +
						result.contextUsage.cache_creation_input_tokens,
				),
			);
			const composerContext = page.getByTestId("composer-word-context-usage");
			await expect(composerContext).toHaveText(`${contextPct}%`);
			await page.reload();
			await expect(
				meta.getByTitle("Fresh input tokens", { exact: true }),
			).toHaveText(`${sdkTokens.input} in`);
			await expect(
				meta.getByTitle("Output tokens", { exact: true }),
			).toHaveText(`${sdkTokens.output} out`);
			await expect(context).toContainText(`${contextPct}%`);
			await expect(composerContext).toHaveText(`${contextPct}%`);
			report["reloaded"] = {
				input: await meta
					.getByTitle("Fresh input tokens", { exact: true })
					.innerText(),
				output: await meta
					.getByTitle("Output tokens", { exact: true })
					.innerText(),
				context: await context.innerText(),
				composerContext: await composerContext.innerText(),
			};
		} finally {
			const path = testInfo.outputPath("turn-working-time-report.json");
			writeFileSync(path, JSON.stringify(report, null, 2));
			await testInfo.attach("turn-working-time-report.json", {
				path,
				contentType: "application/json",
			});
			const screenshot = testInfo.outputPath("turn-working-time.png");
			await page.screenshot({ path: screenshot, animations: "disabled" });
			await testInfo.attach("turn-working-time.png", {
				path: screenshot,
				contentType: "image/png",
			});
		}
	});
});
