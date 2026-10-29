// Browser guards for conduit-test-8rdf.3 and the client half of 8rdf.5.
// Failures to guard: re-rendering all 292 text parts on a single delta,
// dropping/reordering parts in a batch, and quadratic snapshot installation.
// CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//   --config test/e2e/playwright-harness.config.ts harness-transcript-performance

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	EventPayloadMap,
	LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

type Snapshot = Extract<SessionDetailEnvelope, { _tag: "snapshot" }>;
const STREAM_SESSION = "perf-stream";
const TEXT_PARTS = 292;
const BASE_PARTS = 750;
const SAMPLES = 7;
const messageId = (session: string) => `${session}-assistant`;
const partId = (session: string, index: number) => `${session}-part-${index}`;
const text = (index: number) => `Part ${index}: **stable markdown**.`;
const marker = (session: string) => `END-OF-${session}`;

const seed = (
	filename: string,
	sessions: readonly { id: string; parts: number; textOnly: boolean }[],
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const events: CanonicalEvent[] = [];
			for (const [index, session] of sessions.entries()) {
				const at = Date.UTC(2026, 9, 1) + index * 10_000;
				const event = <T extends LiveEventType>(
					type: T,
					data: EventPayloadMap[T],
					offset = 0,
				) =>
					canonicalEvent(type, session.id, data, {
						provider: "claude",
						createdAt: at + offset,
					});
				events.push(
					event("session.created", {
						sessionId: session.id,
						title: session.id,
						provider: "claude",
						providerSessionId: session.id,
					}),
					event("message.created", {
						messageId: messageId(session.id),
						role: "assistant",
						sessionId: session.id,
					}),
				);
				for (let part = 0; part < session.parts; part++) {
					const last = part === session.parts - 1;
					events.push(
						event(
							session.textOnly || last ? "text.delta" : "thinking.delta",
							{
								messageId: messageId(session.id),
								partId: partId(session.id, part),
								text: last ? marker(session.id) : text(part),
							},
							part + 1,
						),
					);
				}
			}
			yield* commit(events, { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

// Keep real bootstrap and subscription traffic. Inject updates on the captured
// detail stream, so the production decoder, reducer, projection and UI all run.
const watchDetail = async (page: Page) => {
	const control = {
		snapshot: undefined as Snapshot | undefined,
		send: undefined as ((envelope: SessionDetailEnvelope) => void) | undefined,
		synchronized: false,
	};
	let detailRequestId: unknown;
	await page.routeWebSocket(
		(url) => url.pathname === "/rpc",
		(socket) => {
			const server = socket.connectToServer();
			socket.onMessage((message) => server.send(message));
			server.onMessage((message) => {
				const frame: unknown = JSON.parse(message.toString());
				if (
					typeof frame === "object" &&
					frame !== null &&
					"requestId" in frame &&
					"values" in frame &&
					Array.isArray(frame.values)
				) {
					for (const value of frame.values as unknown[]) {
						if (
							typeof value !== "object" ||
							value === null ||
							!("_tag" in value) ||
							value._tag !== "snapshot" ||
							!("rows" in value) ||
							!Array.isArray(value.rows)
						)
							continue;
						// The frame has already passed the server's typed detail encoder.
						const snapshot = value as Snapshot;
						if (
							!snapshot.rows.some(
								(row) =>
									row._tag === "message" && row.message.id.startsWith("perf-"),
							)
						)
							continue;
						control.snapshot = snapshot;
						detailRequestId = frame.requestId;
						control.synchronized = false;
						control.send = (envelope) =>
							socket.send(JSON.stringify({ ...frame, values: [envelope] }));
					}
					if (
						frame.requestId === detailRequestId &&
						frame.values.some(
							(value: unknown) =>
								typeof value === "object" &&
								value !== null &&
								"_tag" in value &&
								value._tag === "synchronized",
						)
					)
						control.synchronized = true;
				}
				socket.send(message);
			});
		},
	);
	return control;
};

const renderCount = (page: Page) =>
	page.evaluate((id) => {
		const counts = Reflect.get(
			window,
			"__conduitTranscriptMarkdownRenders",
		) as Record<string, number>;
		return counts[id] ?? 0;
	}, messageId(STREAM_SESSION));

const measurements = (page: Page, parts: number) =>
	page.evaluate(
		(partCount) =>
			performance
				.getEntriesByName("conduit:transcript-apply", "measure")
				.filter((entry) => {
					const detail: unknown = (entry as PerformanceMeasure).detail;
					return (
						typeof detail === "object" &&
						detail !== null &&
						"partCount" in detail &&
						detail.partCount === partCount
					);
				})
				.map((entry) => entry.duration),
		parts,
	);
const median = (samples: readonly number[]) =>
	[...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;

test.describe.configure({ retries: 0 });

test("one streamed part renders markdown once in a 292-text-part message", async ({
	harness,
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await harness.terminate();
	await seed(harness.daemonStorePath(), [
		{ id: STREAM_SESSION, parts: TEXT_PARTS, textOnly: true },
	]);
	await harness.restart({ keepPort: true });
	await page.addInitScript(() =>
		Reflect.set(window, "__conduitTranscriptMarkdownRenders", {}),
	);
	const detail = await watchDetail(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const counts: {
		update: number;
		before: number;
		after: number;
		renders: number;
	}[] = [];
	let initialRenders = 0;
	try {
		await new AppPage(page).goto(
			`${harness.baseUrl}/s/${STREAM_SESSION}?p=process-test`,
		);
		await expect(
			page
				.locator(".msg-assistant")
				.filter({ hasText: marker(STREAM_SESSION) }),
		).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".msg-assistant")).toHaveCount(TEXT_PARTS);
		await expect.poll(() => detail.synchronized).toBe(true);
		initialRenders = await renderCount(page);
		const snapshot = detail.snapshot;
		const send = detail.send;
		if (!snapshot || !send)
			throw new Error("No seeded detail snapshot captured");
		const part = snapshot.rows.find(
			(row) =>
				row._tag === "part" &&
				row.part.id === partId(STREAM_SESSION, TEXT_PARTS - 1),
		);
		if (!part || part._tag !== "part")
			throw new Error("Streaming part missing from snapshot");
		let sequence = snapshot.sequence;
		let updatedText = marker(STREAM_SESSION);
		for (let update = 1; update <= 6; update++) {
			const before = await renderCount(page);
			updatedText += ` delta-${update}`;
			const { renderedHtml: _html, ...body } = part.part;
			send({
				_tag: "upsert",
				sequence: ++sequence,
				item: { ...part, part: { ...body, text: updatedText } },
			});
			await expect(page.locator(".msg-assistant").last()).toContainText(
				updatedText,
			);
			// Let the next frame finish as well, catching a redundant install.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			const after = await renderCount(page);
			counts.push({ update, before, after, renders: after - before });
		}
		await expect(page.locator(".msg-assistant")).toHaveCount(TEXT_PARTS);
		await expect(page.locator(".msg-assistant").first()).toContainText(
			"Part 0: stable markdown.",
		);
	} finally {
		mkdirSync("test-results", { recursive: true });
		const output = join(
			"test-results",
			`transcript-streaming.${testInfo.project.name}.json`,
		);
		writeFileSync(
			output,
			`${JSON.stringify({ project: testInfo.project.name, parts: TEXT_PARTS, initialRenders, counts, pageErrors }, null, 2)}\n`,
		);
		await testInfo.attach("transcript-streaming-report", { path: output });
	}
	expect(counts).toHaveLength(6);
	expect(counts.map(({ renders }) => renders)).toEqual([1, 1, 1, 1, 1, 1]);
	expect(pageErrors).toEqual([]);
});

test(
	"snapshot installation scales below 8x for 4x as many parts",
	{ tag: "@timed" },
	async ({ harness, page }, testInfo) => {
		test.setTimeout(180_000);
		const sessions = [1, 2, 4].map((scale) => ({
			id: `perf-snapshot-${scale}`,
			parts: BASE_PARTS * scale,
			textOnly: false,
		}));
		await harness.terminate();
		await seed(harness.daemonStorePath(), sessions);
		await harness.restart({ keepPort: true });
		await page.addInitScript(() =>
			Reflect.set(window, "__conduitMeasureTranscriptApply", true),
		);
		const detail = await watchDetail(page);
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		const times: { parts: number; samplesMs: number[]; medianMs: number }[] =
			[];
		try {
			for (const session of sessions) {
				await new AppPage(page).goto(
					`${harness.baseUrl}/s/${session.id}?p=process-test`,
				);
				await expect(
					page
						.locator(".msg-assistant")
						.filter({ hasText: marker(session.id) }),
				).toBeVisible({ timeout: 30_000 });
				await expect.poll(() => detail.synchronized).toBe(true);
				const snapshot = detail.snapshot;
				const send = detail.send;
				if (!snapshot || !send)
					throw new Error("No seeded detail snapshot captured");
				const parts = snapshot.rows.filter(
					(row) =>
						row._tag === "part" && row.messageId === messageId(session.id),
				);
				expect(parts).toHaveLength(session.parts);
				expect(
					parts
						.map((row) => (row._tag === "part" ? row.sortOrder : -1))
						.sort((a, b) => a - b),
				).toEqual(Array.from({ length: session.parts }, (_, index) => index));
				// Initial installation warms the code. Measure repeated real applies;
				// the median limits timer/JIT/GC noise without hiding quadratic growth.
				await expect
					.poll(() =>
						measurements(page, session.parts).then((entries) => entries.length),
					)
					.toBeGreaterThan(0);
				await page.evaluate(() =>
					performance.clearMeasures("conduit:transcript-apply"),
				);
				for (let sample = 0; sample < SAMPLES; sample++) {
					send({ ...snapshot, sequence: snapshot.sequence + sample + 1 });
					await expect
						.poll(() =>
							measurements(page, session.parts).then(
								(entries) => entries.length,
							),
						)
						.toBe(sample + 1);
				}
				const samplesMs = await measurements(page, session.parts);
				times.push({
					parts: session.parts,
					samplesMs,
					medianMs: median(samplesMs),
				});
			}
		} finally {
			mkdirSync("test-results", { recursive: true });
			const output = join(
				"test-results",
				`transcript-snapshot.${testInfo.project.name}.json`,
			);
			const ratio = (times[2]?.medianMs ?? 0) / (times[0]?.medianMs ?? 0);
			writeFileSync(
				output,
				`${JSON.stringify({ project: testInfo.project.name, baseParts: BASE_PARTS, times, ratio4xTo1x: ratio, pageErrors }, null, 2)}\n`,
			);
			await testInfo.attach("transcript-snapshot-report", { path: output });
		}
		expect(times).toHaveLength(3);
		expect(times[0]?.medianMs).toBeGreaterThan(0);
		expect((times[2]?.medianMs ?? 0) / (times[0]?.medianMs ?? 0)).toBeLessThan(
			8,
		);
		expect(pageErrors).toEqual([]);
	},
);
