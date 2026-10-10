// Restart under load (conduit-test-y7eo.1). A ~10k-session store, four
// connected devices and three streaming sessions; the daemon restarts and one
// device opens the heavy session. The JSON report is the artifact later
// tickets assert against: it holds today's numbers and only sanity is checked,
// except that devices watching the same thing share its reads: every device
// holds the sidebar, two watch the same stream, and no sidebar or detail window
// is read twice (conduit-test-y7eo.4); and a device reconnecting after the
// restart is sent only the sidebar changes it missed (conduit-test-y7eo.3).
//
// Wire sizes are WebSocket payloads as the page sees them, so after any
// permessage-deflate inflation. Event-loop stalls come from a 10ms sampler in
// the server process; read counts from the read-model-read diagnostics channel.
//
// Timings are only comparable run to run with one worker, as two 10k-session
// servers in parallel skew each other (test/e2e/baselines holds the baseline):
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --workers=1 harness-restart-load

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import {
	HEAVY_FINAL_TEXT,
	HEAVY_SESSION_ID,
	seedSessionLoadFixture,
} from "../../fixtures/session-load.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

interface Frame {
	readonly device: number;
	readonly socket: string;
	readonly direction: "received" | "sent";
	readonly at: number;
	readonly bytes: number;
	readonly head: string;
}

interface Reads {
	readonly reads: Record<string, number>;
	readonly changesRead: number;
}

interface ServerMetrics extends Reads {
	readonly stalls: readonly { readonly at: number; readonly ms: number }[];
	/**
	 * Keyed by source name, e.g. `shell` or `session-detail/<id>`, with the
	 * distinct version windows each read.
	 */
	readonly sources: Record<string, Reads & { readonly windowsRead: number }>;
	readonly sidebarReads: readonly {
		readonly at: number;
		readonly ms: number;
		readonly rows: number;
	}[];
	readonly flushedAt: number;
}

const DEVICES = 4;
const STREAMS = 3;
// The stream each device watches; the rest (the opener) watch the sidebar.
// Two devices share a stream, and every device holds the sidebar.
const WATCHED_STREAM: readonly number[] = [0, 0, 1];
const SETTLE_MS = 2_000;

// Totals and size spread for one window of frames, per socket path.
const wire = (frames: readonly Frame[]) => {
	const summary = (subset: readonly Frame[]) => {
		const sizes = subset.map(({ bytes }) => bytes).sort((a, b) => a - b);
		return {
			frames: subset.length,
			bytes: sizes.reduce((total, bytes) => total + bytes, 0),
			maxFrameBytes: sizes.at(-1) ?? 0,
			p95FrameBytes: sizes[Math.floor(sizes.length * 0.95)] ?? 0,
		};
	};
	const received = frames.filter(({ direction }) => direction === "received");
	return {
		received: summary(received),
		sent: summary(frames.filter(({ direction }) => direction === "sent")),
		bySocket: Object.fromEntries(
			[...new Set(received.map(({ socket }) => socket))].map((socket) => [
				socket,
				summary(received.filter((frame) => frame.socket === socket)),
			]),
		),
		largestReceived: [...received]
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 5)
			.map(({ device, socket, bytes, head }) => ({
				device,
				socket,
				bytes,
				head,
			})),
	};
};

const between = (frames: readonly Frame[], from: number, to: number) =>
	frames.filter(({ at }) => at >= from && at <= to);

const serverMetrics = async (file: string): Promise<ServerMetrics> => {
	const asked = Date.now();
	// The server flushes every 250ms; wait for a flush that covers `asked`.
	await expect
		.poll(
			() => (JSON.parse(readFileSync(file, "utf8")) as ServerMetrics).flushedAt,
		)
		.toBeGreaterThan(asked);
	return JSON.parse(readFileSync(file, "utf8")) as ServerMetrics;
};

// Reads since `start`, and how many window reads each change cost. A window
// read serves one change for every subscriber of its source asking it then.
const readsSince = (start: Reads | undefined, end: Reads) => {
	const reads = Object.fromEntries(
		Object.entries(end.reads).map(([kind, count]) => [
			kind,
			count - (start?.reads[kind] ?? 0),
		]),
	);
	const changesRead = end.changesRead - (start?.changesRead ?? 0);
	return {
		reads,
		changesRead,
		windowReadsPerChange:
			changesRead === 0
				? 0
				: Math.round(((reads["window"] ?? 0) / changesRead) * 10) / 10,
	};
};

// Stalls inside [from, to], and reads since `start` (or since server start).
// Totals sum every subscription source: shell, detail, family, approvals and
// todos; `bySource` splits them by source name.
const serverWindow = (
	start: ServerMetrics | undefined,
	end: ServerMetrics,
	from: number,
	to: number,
) => {
	const stalls = end.stalls.filter(({ at }) => at >= from && at <= to);
	const sidebar = end.sidebarReads.filter(({ at }) => at >= from && at <= to);
	const sidebarMs = sidebar.map(({ ms }) => ms).sort((a, b) => a - b);
	const round = (ms: number) => Math.round(ms * 100) / 100;
	return {
		stalls: {
			count: stalls.length,
			totalMs: stalls.reduce((total, { ms }) => total + ms, 0),
			longest: [...stalls]
				.sort((a, b) => b.ms - a.ms)
				.slice(0, 5)
				.map(({ at, ms }) => ({ atMs: at - from, ms })),
		},
		...readsSince(start, end),
		bySource: Object.fromEntries(
			Object.entries(end.sources).map(([name, source]) => [
				name,
				{
					...readsSince(start?.sources[name], source),
					windowsRead:
						source.windowsRead - (start?.sources[name]?.windowsRead ?? 0),
				},
			]),
		),
		// Server time spent in sidebar (shell) reads of every kind.
		sidebarReads: {
			count: sidebar.length,
			totalMs: round(sidebarMs.reduce((total, ms) => total + ms, 0)),
			medianMs: round(sidebarMs[Math.floor(sidebarMs.length / 2)] ?? 0),
			maxMs: round(sidebarMs.at(-1) ?? 0),
			rows: sidebar.reduce((total, { rows }) => total + rows, 0),
		},
	};
};

test.describe.configure({ retries: 0 });

test("opens the heavy session after a restart under load", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(180_000);
	const { viewport, isMobile, hasTouch } = testInfo.project.use;

	// Seed into the store the first daemon created, then start on it.
	await harness.terminate();
	const fixture = await seedSessionLoadFixture(harness.projectStorePath());
	const storeBytes = statSync(harness.projectStorePath()).size;
	const warmMetrics = join(harness.root, "server-metrics-warm.json");
	// The harness probe opens a detail stream per sidebar row; skip it here and
	// confirm the fake SDK once the driver has attached instead.
	await harness.restart({
		keepPort: true,
		metricsFile: warmMetrics,
		skipBrowserProbe: true,
	});

	const driver = await harness.connect(undefined, undefined, undefined, false);
	await expect.poll(() => harness.generations.at(-1)?.fakeSdkActive).toBe(true);
	const streams: string[] = [];
	for (let index = 0; index < STREAMS; index++) {
		const sessionId = await driver.createSession(`Stream ${index}`);
		await Effect.runPromise(
			driver.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: driver.originId,
				inputId: randomUUID(),
				text: `load-stream-${index}`,
				delivery: "queue",
			}),
		);
		streams.push(sessionId);
	}
	await driver.close();

	const frames: Frame[] = [];
	const pages: Page[] = [];
	for (let device = 0; device < DEVICES; device++) {
		const context = await browser.newContext({
			...(viewport ? { viewport } : {}),
			...(isMobile === undefined ? {} : { isMobile }),
			...(hasTouch === undefined ? {} : { hasTouch }),
		});
		const page = await context.newPage();
		page.on("websocket", (socket) => {
			const path = new URL(socket.url()).pathname;
			const record =
				(direction: Frame["direction"]) =>
				({ payload }: { payload: string | Buffer }) =>
					frames.push({
						device,
						socket: path,
						direction,
						at: Date.now(),
						bytes: Buffer.byteLength(payload),
						head: payload.toString().slice(0, 120),
					});
			socket.on("framereceived", record("received"));
			socket.on("framesent", record("sent"));
		});
		pages.push(page);
	}
	const opener = pages[DEVICES - 1];
	if (!opener) throw new Error("No opener device");
	const heavyRow = opener.locator(
		`[data-session-id="${HEAVY_SESSION_ID}"] .session-item-title:visible`,
	);
	await Promise.all(
		pages.map(async (page, device) => {
			const watched = WATCHED_STREAM[device];
			const stream = watched === undefined ? undefined : streams[watched];
			await new AppPage(page).goto(
				stream === undefined
					? `${harness.baseUrl}/?p=process-test`
					: `${harness.baseUrl}/s/${stream}?p=process-test`,
			);
			await expect(
				stream === undefined
					? heavyRow
					: page.locator(".msg-assistant").filter({ hasText: "tick(" }),
			).toBeVisible({ timeout: 30_000 });
		}),
	);
	const warmStart = await serverMetrics(warmMetrics);
	const warmFrom = Date.now();
	await opener.waitForTimeout(SETTLE_MS);
	const warmTo = Date.now();
	const warm = await serverMetrics(warmMetrics);

	const restartMetrics = join(harness.root, "server-metrics-restart.json");
	const restartAt = Date.now();
	await harness.terminate();
	const stoppedAt = Date.now();
	await harness.restart({
		keepPort: true,
		metricsFile: restartMetrics,
		skipBrowserProbe: true,
	});
	const readyAt = Date.now();

	// Pick the row the way a user does, as soon as the server is back, and
	// time it in the page to the frame that first shows the newest reply.
	await expect(heavyRow).toBeVisible({ timeout: 30_000 });
	const clickAt = Date.now();
	const openMs = await opener.evaluate(
		async ({ id, text }) => {
			const started = performance.now();
			document
				.querySelector<HTMLElement>(
					`[data-session-id="${id}"] .session-item-title`,
				)
				?.click();
			await new Promise<void>((resolve) => {
				const check = () =>
					[...document.querySelectorAll(".msg-assistant")].some((message) =>
						message.textContent?.includes(text),
					)
						? resolve()
						: requestAnimationFrame(check);
				check();
			});
			return Math.round(performance.now() - started);
		},
		{ id: HEAVY_SESSION_ID, text: HEAVY_FINAL_TEXT },
	);
	const visibleAt = Date.now();
	await expect(
		opener.locator(".msg-assistant").filter({ hasText: HEAVY_FINAL_TEXT }),
	).toBeVisible();
	await opener.waitForTimeout(SETTLE_MS);
	const restartTo = Date.now();

	const restarted = await serverMetrics(restartMetrics);
	const report = {
		schema: 1,
		project: testInfo.project.name,
		recordedAt: new Date().toISOString(),
		fixture: { ...fixture, storeBytes },
		devices: DEVICES,
		streamingSessions: STREAMS,
		restart: { stopMs: stoppedAt - restartAt, startMs: readyAt - stoppedAt },
		// Per device: from the old server stopping to the new one's first frame.
		reconnectMs: pages.map(
			(_, device) =>
				(frames.find(
					(frame) =>
						frame.device === device &&
						frame.direction === "received" &&
						frame.at >= stoppedAt,
				)?.at ?? Number.NaN) - stoppedAt,
		),
		open: {
			sessionId: HEAVY_SESSION_ID,
			ms: openMs,
			fromReadyMs: visibleAt - readyAt,
			wire: wire(
				between(frames, clickAt, visibleAt).filter(
					({ device }) => device === DEVICES - 1,
				),
			),
		},
		wire: {
			warm: {
				ms: warmTo - warmFrom,
				...wire(between(frames, warmFrom, warmTo)),
			},
			restart: {
				ms: restartTo - restartAt,
				...wire(between(frames, restartAt, restartTo)),
				byDevice: pages.map(
					(_, device) =>
						wire(
							between(frames, restartAt, restartTo).filter(
								(frame) => frame.device === device,
							),
						).received,
				),
			},
		},
		server: {
			warm: serverWindow(warmStart, warm, warmFrom, warmTo),
			restart: serverWindow(undefined, restarted, stoppedAt, restartTo),
		},
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`restart-load.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("restart-load-report", { path: output });

	// Sanity only; targets arrive with the tickets that move them.
	expect(fixture.sessions).toBeGreaterThanOrEqual(10_000);
	expect(openMs).toBeGreaterThan(0);
	expect(report.open.wire.received.frames).toBeGreaterThan(0);
	for (const device of report.wire.restart.byDevice)
		expect(device.frames).toBeGreaterThan(0);
	expect(report.reconnectMs.every(Number.isFinite)).toBe(true);
	// Devices that keep pace ask the same window and share one read of it; one
	// that falls behind catches up with one read of its own, a different window
	// (conduit-test-y7eo.4).
	const shared = report.server.warm.bySource;
	for (const name of ["shell", `session-detail/${streams[0]}`]) {
		expect(shared[name]?.changesRead, name).toBeGreaterThan(0);
		expect(shared[name]?.reads["window"], name).toBe(shared[name]?.windowsRead);
	}
	// Every device reconnects with its cursor and is sent the sidebar changes
	// past it, not the list again: no base read, and fewer rows across all four
	// than one list holds (conduit-test-y7eo.3).
	const afterRestart = report.server.restart;
	expect(afterRestart.bySource["shell"]?.reads).not.toHaveProperty("base");
	expect(afterRestart.bySource["shell"]?.reads["resume"]).toBe(DEVICES);
	expect(afterRestart.sidebarReads.rows).toBeLessThan(fixture.families);
	for (const page of pages) await page.context().close();
});
