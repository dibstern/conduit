// Restart under load (conduit-test-y7eo.1). A ~10k-session store, four
// connected devices and three streaming sessions; the daemon restarts and one
// device opens the heavy session. The JSON report is the artifact later
// tickets assert against: it holds today's numbers and only sanity is checked,
// except that devices watching the same thing share its reads: every device
// holds the sidebar, two watch the same stream, and no sidebar or detail window
// is read twice (conduit-test-y7eo.4), nor any session-family or approvals
// window, and a family read scans no session table (conduit-test-y7eo.15);
// a device reconnecting after the
// restart is sent only the sidebar changes it missed (conduit-test-y7eo.3). A
// long turn's live frames stay flat, and a resume after a restart brings only
// the parts that moved yet lands on the transcript a cold open shows
// (conduit-test-y7eo.8). Tool-detail prefetch (conduit-test-y7eo.11) is kept
// out: no device sees a turn activity block on screen, so the numbers measure
// the open alone.
//
// The heavy session is also opened cold on a fresh device, and the report
// records what held the server's event loop during each open: stalls, the
// longest SQLite statements and a CPU profile's top costs; they decide the two
// gated follow-ups (conduit-test-y7eo.12).
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
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	/**
	 * SQLite statements that held the loop 1ms or more, by end time, from a
	 * server started with `profile`.
	 */
	readonly statements?: readonly {
		readonly at: number;
		readonly ms: number;
		readonly method: string;
		readonly sql: string;
	}[];
	/**
	 * Every session-family read, however long its statements took, from a
	 * server started with `profile`: whether its window held a changed member,
	 * and how many of its statements read every session row.
	 */
	readonly familyReads?: readonly {
		readonly at: number;
		readonly changed: boolean;
		readonly fullSessionScans: number;
	}[];
	readonly flushedAt: number;
}

interface CpuProfile {
	readonly stoppedAt: number;
	readonly profile: {
		readonly nodes: readonly {
			readonly id: number;
			readonly callFrame: {
				readonly functionName: string;
				readonly url: string;
				readonly lineNumber: number;
			};
			readonly children?: readonly number[];
		}[];
		readonly startTime: number;
		readonly endTime: number;
		readonly samples: readonly number[];
		readonly timeDeltas: readonly number[];
	};
}

const DEVICES = 4;
const STREAMS = 3;
// The stream each device watches; the rest (the opener) watch the sidebar.
// Two devices share a stream, and every device holds the sidebar.
const WATCHED_STREAM: readonly number[] = [0, 0, 1];
const SETTLE_MS = 2_000;
// The long turn's tool calls, and the follow-up's that lands while away.
const LONG_TURN_CALLS = 40;
const FOLLOW_UP_CALLS = 3;
// Fixed ceilings, in encoded bytes, for the frames tool previews shape
// (conduit-test-y7eo.6), each a little over what it measured: a live update
// 4,945 to 5,516, and a detail response 46,608, which carries the whole result
// by design. The heavy first page (2,030,012 before previews, 279,833 after)
// is held to the page budget (conduit-test-y7eo.7).
const TOOL_PREVIEW_LIMITS = {
	heavyFirstPageBytes: 256 * 1024,
	liveToolUpdateBytes: 8_000,
	detailResponseBytes: 50_000,
};

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
	const metrics = JSON.parse(readFileSync(file, "utf8")) as ServerMetrics;
	// Appended before each flush; a line still being written has no newline.
	const statements = `${file}.statements.jsonl`;
	return existsSync(statements)
		? {
				...metrics,
				statements: readFileSync(statements, "utf8")
					.split("\n")
					.slice(0, -1)
					.map(
						(line) =>
							JSON.parse(line) as NonNullable<
								ServerMetrics["statements"]
							>[number],
					),
			}
		: metrics;
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

const round = (ms: number) => Math.round(ms * 100) / 100;

// What held the server's event loop inside [from, to]: stalls, and when timed,
// the SQLite statements that ran 1ms or more, longest first
// (conduit-test-y7eo.12).
const blocking = (end: ServerMetrics, from: number, to: number) => {
	const inside = <T extends { readonly at: number }>(items: readonly T[]) =>
		items.filter(({ at }) => at >= from && at <= to);
	const stalls = inside(end.stalls);
	const statements = end.statements && inside(end.statements);
	const familyReads = end.familyReads && inside(end.familyReads);
	return {
		stalls: {
			count: stalls.length,
			totalMs: stalls.reduce((total, { ms }) => total + ms, 0),
			longest: [...stalls]
				.sort((a, b) => b.ms - a.ms)
				.slice(0, 5)
				.map(({ at, ms }) => ({ atMs: at - from, ms })),
		},
		...(statements && {
			database: {
				count: statements.length,
				totalMs: round(statements.reduce((total, { ms }) => total + ms, 0)),
				longest: [...statements]
					.sort((a, b) => b.ms - a.ms)
					.slice(0, 5)
					.map(({ at, ...statement }) => ({ atMs: at - from, ...statement })),
				// The longest read alone, which the gated read worker targets.
				longestRead: statements
					.filter(({ sql }) => /^(SELECT|WITH)\b/i.test(sql))
					.sort((a, b) => b.ms - a.ms)
					.slice(0, 1)
					.map(({ at, ...statement }) => ({
						atMs: at - from,
						...statement,
					}))[0],
			},
		}),
		// Session-family reads by whether their window held a changed member,
		// and the reads of every session row they made. Counted per read, not
		// from the statement log, which holds only statements of 1ms or more and
		// every other caller's too (conduit-test-y7eo.15).
		...(familyReads && {
			familyReads: {
				unchanged: familyReads.filter(({ changed }) => !changed).length,
				changed: familyReads.filter(({ changed }) => changed).length,
				fullSessionScans: familyReads.reduce(
					(total, read) => total + read.fullSessionScans,
					0,
				),
			},
		}),
	};
};

// Where the server's CPU went inside [from, to], from the sampled profile:
// busy and idle time, time under the SQLite client, and the ten frames with
// the most self time.
const cpuCosts = (
	{ stoppedAt, profile }: CpuProfile,
	from: number,
	to: number,
) => {
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parents = new Map(
		profile.nodes.flatMap(({ id, children = [] }) =>
			children.map((child) => [child, id] as const),
		),
	);
	const frame = (id: number) => {
		const { functionName, url, lineNumber } = nodes.get(id)?.callFrame ?? {
			functionName: "?",
			url: "",
			lineNumber: 0,
		};
		const file = url.split("/").slice(-2).join("/");
		return `${functionName || "(anonymous)"}${file ? ` ${file}:${lineNumber + 1}` : ""}`;
	};
	const self = new Map<string, number>();
	let busyMs = 0;
	let idleMs = 0;
	let databaseMs = 0;
	// Sample times are profile microseconds; the profile ends at `stoppedAt`.
	let sampledAt = profile.startTime;
	profile.samples.forEach((id, index) => {
		sampledAt += profile.timeDeltas[index] ?? 0;
		const at = stoppedAt - (profile.endTime - sampledAt) / 1000;
		const ms = (profile.timeDeltas[index + 1] ?? 0) / 1000;
		if (at < from || at > to) return;
		if (nodes.get(id)?.callFrame.functionName === "(idle)") {
			idleMs += ms;
			return;
		}
		busyMs += ms;
		self.set(frame(id), (self.get(frame(id)) ?? 0) + ms);
		for (
			let node: number | undefined = id;
			node !== undefined;
			node = parents.get(node)
		) {
			if (nodes.get(node)?.callFrame.url.includes("sql-sqlite-node")) {
				databaseMs += ms;
				break;
			}
		}
	});
	return {
		busyMs: round(busyMs),
		idleMs: round(idleMs),
		databaseMs: round(databaseMs),
		topSelf: [...self]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([frame, ms]) => ({ frame, ms: round(ms) })),
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
	const sidebar = end.sidebarReads.filter(({ at }) => at >= from && at <= to);
	const sidebarMs = sidebar.map(({ ms }) => ms).sort((a, b) => a - b);
	return {
		...blocking(end, from, to),
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
	test.setTimeout(300_000);
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
	// Whole /rpc payloads the opener receives, kept only while sizes are pinned.
	let pinned: { bytes: number; payload: string }[] | undefined;
	const pages: Page[] = [];
	for (let device = 0; device < DEVICES; device++) {
		const context = await browser.newContext({
			...(viewport ? { viewport } : {}),
			...(isMobile === undefined ? {} : { isMobile }),
			...(hasTouch === undefined ? {} : { hasTouch }),
		});
		const page = await context.newPage();
		// No turn activity block reports itself on screen, so nothing is
		// prefetched (conduit-test-y7eo.11) and every window measures only
		// what opening and restarting cost.
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
		page.on("websocket", (socket) => {
			const path = new URL(socket.url()).pathname;
			const record =
				(direction: Frame["direction"]) =>
				({ payload }: { payload: string | Buffer }) => {
					const bytes = Buffer.byteLength(payload);
					frames.push({
						device,
						socket: path,
						direction,
						at: Date.now(),
						bytes,
						head: payload.toString().slice(0, 120),
					});
					if (
						pinned &&
						device === DEVICES - 1 &&
						direction === "received" &&
						path === "/rpc"
					)
						pinned.push({ bytes, payload: payload.toString() });
				};
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
		profile: true,
		skipBrowserProbe: true,
	});
	const readyAt = Date.now();
	// Profile from here to the cold open below, leaving startup out.
	writeFileSync(`${restartMetrics}.start`, "");

	// Pick the row the way a user does, as soon as the server is back, and
	// time it in the page to the frame that first shows the newest reply.
	await expect(heavyRow).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => existsSync(`${restartMetrics}.started`)).toBe(true);
	const clickAt = Date.now();
	pinned = [];
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
	const heavyFirstPageBytes = Math.max(
		0,
		...pinned
			.filter(({ payload }) => payload.includes(HEAVY_FINAL_TEXT))
			.map(({ bytes }) => bytes),
	);
	pinned = undefined;
	await expect(
		opener.locator(".msg-assistant").filter({ hasText: HEAVY_FINAL_TEXT }),
	).toBeVisible();
	await opener.waitForTimeout(SETTLE_MS);
	const restartTo = Date.now();

	const restarted = await serverMetrics(restartMetrics);

	// Encoded sizes tool previews keep small (conduit-test-y7eo.6): the heavy
	// session's first page above, then one live update of a Bash call with a
	// long command and result, and that call's full detail when expanded.
	pinned = [];
	const toolDriver = await harness.connect(
		undefined,
		undefined,
		undefined,
		false,
	);
	const toolSession = await toolDriver.createSession("Long tool");
	await new AppPage(opener).goto(
		`${harness.baseUrl}/s/${toolSession}?p=process-test`,
	);
	await Effect.runPromise(
		toolDriver.rpc.input.submit({
			projectSlug: "process-test",
			sessionId: toolSession,
			originId: toolDriver.originId,
			inputId: randomUUID(),
			delivery: "queue",
			text: "tool-long-pinned",
		}),
	);
	const completedTool = () =>
		pinned?.find(
			({ payload }) =>
				payload.includes('"tool":"Bash"') &&
				payload.includes('"status":"completed"'),
		);
	await expect.poll(() => completedTool()?.bytes).toBeGreaterThan(0);
	const toggle = opener.locator(".turn-activity-toggle").last();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	const toolRow = opener.locator(".tool-item").last();
	await toolRow.locator("button").first().click();
	// Every call waits seconds on a server this loaded.
	await expect(toolRow).toContainText("END-OF-result", { timeout: 30_000 });
	const toolPreviews = {
		heavyFirstPageBytes,
		liveToolUpdateBytes: completedTool()?.bytes ?? 0,
		detailResponseBytes:
			pinned.find(({ payload }) => payload.includes('"tools":[{"toolId"'))
				?.bytes ?? 0,
		limits: TOOL_PREVIEW_LIMITS,
	};
	pinned = undefined;
	await toolDriver.close();

	// A long turn sends each change as the parts it moved (conduit-test-y7eo.8):
	// its live frames stay flat however many tool calls the message holds.
	const longDriver = await harness.connect(
		undefined,
		undefined,
		undefined,
		false,
	);
	const longSession = await longDriver.createSession("Long turn");
	await new AppPage(opener).goto(
		`${harness.baseUrl}/s/${longSession}?p=process-test`,
	);
	pinned = [];
	// A loaded server takes a few hundred ms a call.
	await longDriver.send(longSession, `load-tools-${LONG_TURN_CALLS}`, 120_000);
	const lastResult = `load-tool-${LONG_TURN_CALLS}-${LONG_TURN_CALLS}-result`;
	await expect
		.poll(() => pinned?.some(({ payload }) => payload.includes(lastResult)))
		.toBe(true);
	const turnFrames = pinned
		.filter(
			({ payload }) =>
				payload.includes('"_tag":"upsert"') &&
				payload.includes(`load-tool-${LONG_TURN_CALLS}-`),
		)
		.map(({ bytes, payload }) => ({
			bytes,
			// One read can carry several changed parts; size each by its parts.
			parts: payload.split('"_tag":"part"').length - 1,
		}));
	const perPart = turnFrames.map(
		({ bytes, parts }) => bytes / Math.max(1, parts),
	);
	const quarter = Math.max(1, Math.floor(perPart.length / 4));
	const median = (sizes: readonly number[]) =>
		[...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0;

	// The heavy session opened cold, as a reload or a relaunched phone app does
	// it: a fresh device, timed in the page from navigation to the newest reply.
	// After the timed phases above, as it leaves seconds of queued reads behind.
	const coldStart = await serverMetrics(restartMetrics);
	const coldOpener = await (
		await browser.newContext({
			...(viewport ? { viewport } : {}),
			...(isMobile === undefined ? {} : { isMobile }),
			...(hasTouch === undefined ? {} : { hasTouch }),
		})
	).newPage();
	const coldFrom = Date.now();
	await coldOpener.goto(
		`${harness.baseUrl}/s/${HEAVY_SESSION_ID}?p=process-test`,
	);
	const coldOpenMs = await (
		await coldOpener.waitForFunction(
			(text) =>
				[...document.querySelectorAll(".msg-assistant")].some((message) =>
					message.textContent?.includes(text),
				) && Math.round(performance.now()),
			HEAVY_FINAL_TEXT,
			{ polling: "raf", timeout: 30_000 },
		)
	).jsonValue();
	const coldTo = Date.now();
	await coldOpener.context().close();

	writeFileSync(`${restartMetrics}.stop`, "");
	const opened = await serverMetrics(restartMetrics);
	await expect
		.poll(() => existsSync(`${restartMetrics}.cpuprofile`), {
			timeout: 30_000,
		})
		.toBe(true);
	const profile = JSON.parse(
		readFileSync(`${restartMetrics}.cpuprofile`, "utf8"),
	) as CpuProfile;
	await testInfo.attach("restart-server-cpuprofile", {
		path: `${restartMetrics}.cpuprofile`,
	});

	// Away from the session, a follow-up turn lands and the server restarts;
	// coming back resumes from the cursor the device holds.
	const pick = (page: Page, id: string) =>
		page.evaluate(
			(id) =>
				document
					.querySelector<HTMLElement>(
						`[data-session-id="${id}"] .session-item-title`,
					)
					?.click(),
			id,
		);
	await pick(opener, toolSession);
	await expect(opener).toHaveURL(new RegExp(toolSession));
	await longDriver.send(longSession, `load-tools-${FOLLOW_UP_CALLS}`, 60_000);
	await longDriver.close();
	await harness.terminate();
	const longRestartAt = Date.now();
	await harness.restart({ keepPort: true, skipBrowserProbe: true });
	await expect
		.poll(
			() =>
				frames.some(
					(frame) =>
						frame.device === DEVICES - 1 &&
						frame.direction === "received" &&
						frame.at > longRestartAt,
				),
			{ timeout: 30_000 },
		)
		.toBe(true);
	await opener.waitForTimeout(SETTLE_MS);
	pinned = [];
	await pick(opener, longSession);
	const followUp = `load-tools-${FOLLOW_UP_CALLS}`;
	await expect(opener.locator("#messages")).toContainText(followUp);
	await opener.waitForTimeout(SETTLE_MS);
	const resumed = pinned;
	pinned = undefined;

	// The same session opened cold, on a fresh device.
	const cold = await (
		await browser.newContext({
			...(viewport ? { viewport } : {}),
			...(isMobile === undefined ? {} : { isMobile }),
			...(hasTouch === undefined ? {} : { hasTouch }),
		})
	).newPage();
	let wholeMessageBytes = 0;
	cold.on("websocket", (socket) =>
		socket.on("framereceived", ({ payload }) => {
			if (payload.toString().includes(lastResult))
				wholeMessageBytes = Math.max(
					wholeMessageBytes,
					Buffer.byteLength(payload),
				);
		}),
	);
	await new AppPage(cold).goto(
		`${harness.baseUrl}/s/${longSession}?p=process-test`,
	);
	await expect(cold.locator("#messages")).toContainText(followUp);
	await cold.waitForTimeout(SETTLE_MS);
	const transcriptOf = async (page: Page) => {
		const collapsed = page.locator(
			'#messages .turn-activity-toggle[aria-expanded="false"]',
		);
		while ((await collapsed.count()) > 0) await collapsed.first().click();
		// The scroll button shows only while the view is detached: leave it out,
		// so a scroll race can neither fake nor mask a difference in content.
		return (
			await page.locator("#messages > :not(#scroll-btn)").allInnerTexts()
		).join("\n");
	};
	const [resumedTranscript, coldTranscript] = [
		await transcriptOf(opener),
		await transcriptOf(cold),
	];
	const longTurn = {
		calls: LONG_TURN_CALLS,
		liveFrames: turnFrames.length,
		partsSent: turnFrames.reduce((total, { parts }) => total + parts, 0),
		firstQuartileMedianBytesPerPart: Math.round(
			median(perPart.slice(0, quarter)),
		),
		lastQuartileMedianBytesPerPart: Math.round(median(perPart.slice(-quarter))),
		maxFrameBytes: Math.max(0, ...turnFrames.map(({ bytes }) => bytes)),
		// What each late frame carried when a change re-sent the whole message.
		wholeMessageBytes,
		resume: {
			frames: resumed.length,
			bytes: resumed.reduce((total, { bytes }) => total + bytes, 0),
			resentEarlierTurn: resumed.some(({ payload }) =>
				payload.includes(`load-tool-${LONG_TURN_CALLS}-`),
			),
			carriedFollowUp: resumed.some(({ payload }) =>
				payload.includes(`load-tool-${FOLLOW_UP_CALLS}-`),
			),
		},
		resumedEqualsCold: resumedTranscript === coldTranscript,
	};
	await cold.context().close();

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
			server: {
				...blocking(opened, clickAt, visibleAt),
				cpu: cpuCosts(profile, clickAt, visibleAt),
			},
			// The settle after it: the load a cold open below arrives into.
			settle: {
				ms: restartTo - visibleAt,
				...blocking(opened, visibleAt, restartTo),
				cpu: cpuCosts(profile, visibleAt, restartTo),
			},
		},
		coldOpen: {
			sessionId: HEAVY_SESSION_ID,
			ms: coldOpenMs,
			server: {
				...serverWindow(coldStart, opened, coldFrom, coldTo),
				cpu: cpuCosts(profile, coldFrom, coldTo),
			},
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
		toolPreviews,
		longTurn,
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
	expect(coldOpenMs).toBeGreaterThan(0);
	expect(report.open.wire.received.frames).toBeGreaterThan(0);
	for (const device of report.wire.restart.byDevice)
		expect(device.frames).toBeGreaterThan(0);
	expect(report.reconnectMs.every(Number.isFinite)).toBe(true);
	// Devices that keep pace ask the same window and share one read of it; one
	// that falls behind catches up with one read of its own, a different window
	// (conduit-test-y7eo.4).
	// The session family and approvals share theirs too (conduit-test-y7eo.15).
	const shared = report.server.warm.bySource;
	for (const name of [
		"shell",
		`session-detail/${streams[0]}`,
		"approvals",
		`session-family/${streams[0]}`,
	]) {
		expect(shared[name]?.changesRead, name).toBeGreaterThan(0);
		expect(shared[name]?.reads["window"], name).toBe(shared[name]?.windowsRead);
	}
	// The heavy session's family moves in none of the cold open's windows, yet
	// is asked each of them: such a read is its window query alone. No family
	// read, changed or not, reads every session row, on the profiled (restarted)
	// server (conduit-test-y7eo.15).
	expect(
		report.coldOpen.server.bySource[`session-family/${HEAVY_SESSION_ID}`]
			?.reads["window"],
	).toBeGreaterThan(0);
	expect(report.coldOpen.server.familyReads?.unchanged).toBeGreaterThan(0);
	expect(report.server.restart.familyReads?.changed).toBeGreaterThan(0);
	for (const [phase, server] of Object.entries({
		restart: report.server.restart,
		coldOpen: report.coldOpen.server,
	}))
		expect(server.familyReads?.fullSessionScans, phase).toBe(0);
	// Every device reconnects with its cursor and is sent the sidebar changes
	// past it, not the list again: no base read, and fewer rows across all four
	// than one list holds (conduit-test-y7eo.3).
	const afterRestart = report.server.restart;
	expect(afterRestart.bySource["shell"]?.reads).not.toHaveProperty("base");
	expect(afterRestart.bySource["shell"]?.reads["resume"]).toBe(DEVICES);
	expect(afterRestart.sidebarReads.rows).toBeLessThan(fixture.families);
	for (const [name, limit] of Object.entries(TOOL_PREVIEW_LIMITS)) {
		const bytes = toolPreviews[name as keyof typeof TOOL_PREVIEW_LIMITS];
		expect(bytes, name).toBeGreaterThan(0);
		expect(bytes, name).toBeLessThanOrEqual(limit);
	}
	// Flat: a part late in the turn costs about what one early in it did (a
	// completed call carries its result, so a little more), though the message
	// grew 40 calls; re-sending the message grew ~7x over the same span. And no
	// frame comes near the message it belongs to.
	expect(longTurn.liveFrames).toBeGreaterThanOrEqual(LONG_TURN_CALLS / 4);
	expect(longTurn.lastQuartileMedianBytesPerPart).toBeLessThanOrEqual(
		longTurn.firstQuartileMedianBytesPerPart * 1.5,
	);
	expect(longTurn.maxFrameBytes * 5).toBeLessThan(longTurn.wholeMessageBytes);
	// Resume brings only what moved, and lands where a cold open does.
	expect(longTurn.resume).toMatchObject({
		resentEarlierTurn: false,
		carriedFollowUp: true,
	});
	expect(resumedTranscript).toBe(coldTranscript);
	for (const page of pages) await page.context().close();
});
