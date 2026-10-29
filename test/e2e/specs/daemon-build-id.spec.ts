// pnpm build first. CONDUIT_SERVER_BUILD_ID is a test override read once by
// the server process at startup. Restarting with B simulates a second build
// without compiling twice; the browser and normal server use the real build A.
// All daemon HOME/config/project paths and the recorded provider are temporary.
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type BrowserContext,
	test as base,
	expect,
	type Page,
	type TestInfo,
	type WebSocketRoute,
} from "@playwright/test";
import WebSocket from "ws";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";

async function attachBuildEvidence(testInfo: TestInfo, evidence: object) {
	const path = testInfo.outputPath("build-id-evidence.json");
	writeFileSync(path, JSON.stringify(evidence, null, 2));
	await testInfo.attach("build-id-evidence", {
		path,
		contentType: "application/json",
	});
}

/** The status values in one /rpc frame (effect-rpc JSON: one message or a batch). */
function serverStatuses(
	payload: string,
): Array<{ requestId: string; buildId: string }> {
	const parsed = JSON.parse(payload) as unknown;
	const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
		_tag?: string;
		requestId?: string;
		values?: Array<{ buildId?: unknown; protocolVersion?: unknown }>;
	}>;
	return messages.flatMap((message) =>
		message._tag === "Chunk"
			? (message.values ?? []).flatMap((value) =>
					typeof value.buildId === "string" &&
					typeof value.protocolVersion === "number"
						? [{ requestId: String(message.requestId), buildId: value.buildId }]
						: [],
				)
			: [],
	);
}

/** One build ID per SubscribeServerStatus subscription: the page's handshakes. */
function captureBuildHandshakes(page: Page): string[] {
	const handshakes: string[] = [];
	let sockets = 0;
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const socketId = sockets++;
		const seen = new Set<string>();
		socket.on("framereceived", ({ payload }) => {
			for (const { requestId, buildId } of serverStatuses(String(payload))) {
				const key = `${socketId}:${requestId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				handshakes.push(buildId);
			}
		});
	});
	return handshakes;
}

/** Correlate requests with their replies across reconnects, keeping the wire evidence. */
function captureDraftCalls(page: Page) {
	type Frame = {
		_tag: string;
		id?: string | number;
		requestId?: string | number;
		tag?: string;
		payload?: {
			key?: { session?: string; draft?: string };
			text?: string;
			projectSlug?: string;
			draftId?: string;
			draftText?: string;
		};
		exit?: {
			_tag: string;
			value?: { sessionId?: string };
			cause?: unknown;
		};
		values?: Array<{
			_tag?: string;
			text?: string;
			projectId?: string;
			sessionId?: string;
			promotedSessionId?: string;
		}>;
	};
	const calls: Array<{
		socket: number;
		request: { at: number; frame: Frame };
		replies: Array<{ at: number; frame: Frame }>;
	}> = [];
	let sockets = 0;
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const socketId = sockets++;
		const pending = new Map<string, (typeof calls)[number]>();
		const frames = (payload: string | Buffer): Frame[] =>
			[JSON.parse(String(payload))].flat();
		socket.on("framesent", ({ payload }) => {
			for (const frame of frames(payload)) {
				if (
					frame._tag !== "Request" ||
					(frame.tag !== "SyncInputDraft" &&
						frame.tag !== "CreateSession" &&
						frame.tag !== "SubscribeDrafts" &&
						frame.tag !== "ViewSession" &&
						frame.tag !== "SubscribeInputDraft")
				)
					continue;
				const call = {
					socket: socketId,
					request: { at: Date.now(), frame },
					replies: [],
				};
				calls.push(call);
				pending.set(String(frame.id), call);
			}
		});
		socket.on("framereceived", ({ payload }) => {
			for (const frame of frames(payload)) {
				pending
					.get(String(frame.requestId))
					?.replies.push({ at: Date.now(), frame });
			}
		});
	});
	return calls;
}

async function readServerBuildId(baseUrl: string): Promise<string> {
	const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/rpc`);
	try {
		return await new Promise<string>((resolve, reject) => {
			socket.once("open", () =>
				socket.send(
					JSON.stringify({
						_tag: "Request",
						id: "1",
						tag: "SubscribeServerStatus",
						payload: {},
						headers: [],
					}),
				),
			);
			socket.on("message", (data) => {
				const [status] = serverStatuses(String(data));
				if (status) resolve(status.buildId);
			});
			socket.once("error", reject);
			socket.once("close", () => reject(new Error("No server status")));
		});
	} finally {
		if (socket.readyState !== WebSocket.CLOSED) {
			const closed = once(socket, "close");
			socket.close();
			await closed;
		}
	}
}

const test = base.extend<{
	buildDaemon: {
		baseUrl: string;
		buildId: string;
		restart(buildId: string): Promise<void>;
		failSessionCreates(): void;
	};
}>({
	buildDaemon: async ({ browserName: _browserName }, use) => {
		const root = mkdtempSync(join(tmpdir(), "conduit-build-id-"));
		const staticDir = join(root, "frontend");
		mkdirSync(join(root, "build-id-test"));
		mkdirSync(join(root, "build-id-other"));
		cpSync(resolve("dist/frontend"), staticDir, { recursive: true });
		// Simulate an older worker that caches a shell. The mismatch must replace
		// it, clear its cache, and navigate through the current network-only SW.
		writeFileSync(
			join(staticDir, "legacy-sw.js"),
			`self.addEventListener("install", event => {
				event.waitUntil(caches.open("conduit-legacy-shell").then(async cache => {
					const response = await fetch("/");
					await cache.put("/", new Response((await response.text()) + '<!-- stale shell -->', {headers: {"Content-Type": "text/html"}}));
					await self.skipWaiting();
				}));
			});
			self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
			self.addEventListener("fetch", event => {
				if (event.request.mode === "navigate") event.respondWith(caches.match("/").then(response => response || fetch(event.request)));
			});`,
		);
		const mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		let child: ChildProcess | undefined;
		let diagnostics = "";
		const stop = async () => {
			if (!child) return;
			if (child.exitCode !== null || child.signalCode !== null) {
				if (child.exitCode !== 0)
					throw new Error(
						`Test daemon exited ${child.exitCode ?? child.signalCode}: ${diagnostics}`,
					);
				return;
			}
			const exited = once(child, "close");
			child.send("stop");
			const [code, signal] = await exited;
			if (code !== 0)
				throw new Error(`Test daemon exited ${code ?? signal}: ${diagnostics}`);
		};
		const start = async (port = 0, buildId?: string) => {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: join(root, "xdg"),
				CLAUDE_CONFIG_DIR: join(root, "claude"),
				CONDUIT_CONFIG_DIR: join(root, "config"),
			};
			// Never inherit a caller's override for the normal matching case, nor
			// its service supervision: a supervised daemon offers a restart, and
			// the server-update banner then hides the build-mismatch one.
			delete env["CONDUIT_SERVER_BUILD_ID"];
			delete env["CONDUIT_SERVICE"];
			delete env["XPC_SERVICE_NAME"];
			if (buildId) env["CONDUIT_SERVER_BUILD_ID"] = buildId;
			child = fork(
				resolve("dist/test/e2e/helpers/build-id-daemon.js"),
				[root, staticDir, mock.url, String(port)],
				{ env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
			);
			child.stdout?.on("data", (data: Buffer) => {
				diagnostics = (diagnostics + data.toString()).slice(-4000);
			});
			child.stderr?.on("data", (data: Buffer) => {
				diagnostics = (diagnostics + data.toString()).slice(-4000);
			});
			const exited = new Promise<never>((_resolve, reject) => {
				child?.once("exit", (code) => {
					reject(new Error(`Test daemon exited ${code}: ${diagnostics}`));
				});
			});
			const [message] = await Promise.race([once(child, "message"), exited]);
			return message as { port: number; buildId: string };
		};
		try {
			await mock.start();
			const started = await start();
			await use({
				baseUrl: `http://127.0.0.1:${started.port}`,
				buildId: started.buildId,
				failSessionCreates() {
					mock.setExactResponse("POST", "/session", 500, {
						error: "Injected provider session creation failure",
					});
				},
				async restart(buildId) {
					await stop();
					await start(started.port, buildId);
				},
			});
		} finally {
			await stop();
			await mock.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
});

test("server reports the stamped build ID and reads the override at startup", async ({
	buildDaemon,
}, testInfo) => {
	const buildA = await readServerBuildId(buildDaemon.baseUrl);
	expect(buildA).toBe(buildDaemon.buildId);
	expect(buildA).not.toBe("dev");
	const buildB = `${buildA}-B`;
	await buildDaemon.restart(buildB);
	expect(await readServerBuildId(buildDaemon.baseUrl)).toBe(buildB);
	await attachBuildEvidence(testInfo, { buildA, buildB });
});

test("mismatching builds reload once, preserve the latest composer draft, and replace stale shells", async ({
	page,
	buildDaemon,
}, testInfo) => {
	await page.clock.install();
	const handshakes = captureBuildHandshakes(page);
	await page.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	await startNewSession(page);
	await expect(page).toHaveURL(/\/draft\/[^/?]+\b/);
	const input = page.locator("#input");
	await expect(input).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.register("/legacy-sw.js", { scope: "/" });
		await navigator.serviceWorker.ready;
	});
	await expect
		.poll(() =>
			page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
		)
		.toContain("/legacy-sw.js");
	let reloads = 0;
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame())
			reloads++;
	});
	const buildB = `${buildDaemon.buildId}-B`;
	await buildDaemon.restart(buildB);
	const draft = "Unsent draft typed immediately before a build mismatch";
	await input.fill("Earlier unsent draft");
	await expect(
		page.getByText("Saving your draft and reloading…"),
	).toBeVisible();
	await page.waitForFunction(
		() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"),
		undefined,
		{ polling: 10 },
	);
	// The reload notice lasts 750ms after SW activation. Edit near its end so
	// the 300ms debounce cannot save this final text before the automatic reload.
	await page.clock.fastForward(500);
	await input.fill(draft);
	await expect.poll(() => reloads).toBe(1);
	await expect(input).toHaveValue(draft);
	await expect(
		page.locator(".banner-text", { hasText: "different builds" }),
	).toBeVisible();
	// Only after the reload: the stale tab learns build B over plain HTTP and
	// reloads without an RPC handshake. The reloaded page subscribes again when
	// it attaches its project, so the count can exceed one; reloads stays one.
	await expect
		.poll(() => handshakes.filter((id) => id === buildB).length)
		.toBeGreaterThanOrEqual(1);
	await expect
		.poll(() => page.evaluate(() => caches.keys()))
		.not.toContain("conduit-legacy-shell");
	expect(await page.content()).not.toContain("<!-- stale shell -->");
	// Run any delayed reload callback after the mismatched handshake was handled.
	await page.clock.fastForward(1_500);
	expect(reloads).toBe(1);
	await page.screenshot({ path: testInfo.outputPath("build-id-reload.png") });
	await attachBuildEvidence(testInfo, {
		buildA: buildDaemon.buildId,
		buildB,
		handshakes,
		reloads,
		draft: await input.inputValue(),
	});
});

test("matching built page and server IDs never reload on reconnect", async ({
	page,
	buildDaemon,
}, testInfo) => {
	await page.clock.install();
	const handshakes = captureBuildHandshakes(page);
	let navigations = 0;
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame())
			navigations++;
	});
	await page.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	await expect.poll(() => handshakes.length).toBeGreaterThan(0);
	const connectionsBeforeRestart = handshakes.length;
	await buildDaemon.restart(buildDaemon.buildId);
	await expect
		.poll(() => handshakes.length)
		.toBeGreaterThan(connectionsBeforeRestart);
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	// A matching handshake must stay safe past the automatic reload deadline.
	await page.clock.fastForward(1_500);
	expect(navigations).toBe(1);
	await expect(
		page.locator(".banner-text", { hasText: "different builds" }),
	).not.toBeVisible();
	await attachBuildEvidence(testInfo, {
		buildId: buildDaemon.buildId,
		handshakes,
		reloads: navigations - 1,
	});
});

test("a session draft reaches a new device after restart and stays cleared after sending", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	test.setTimeout(90_000);
	const callsA = captureDraftCalls(page);
	let contextB: BrowserContext | undefined;
	let pageB: Page | undefined;
	let callsB: ReturnType<typeof captureDraftCalls> = [];
	let sessionUrl: string | undefined;
	let sessionId: string | undefined;
	const draft =
		"Draft persisted for a device that has never opened this session";
	const completed = (
		calls: ReturnType<typeof captureDraftCalls>,
		tag: "SyncInputDraft" | "SubscribeInputDraft",
		text: string,
	) =>
		calls.some(
			({ request, replies }) =>
				request.frame.tag === tag &&
				request.frame.payload?.key?.session === sessionId &&
				(tag !== "SyncInputDraft" || request.frame.payload?.text === text) &&
				replies.some(({ frame }) =>
					tag === "SyncInputDraft"
						? frame._tag === "Exit" && frame.exit?._tag === "Success"
						: frame._tag === "Chunk" &&
							frame.values?.some(
								(value) => value._tag === "synchronized" && value.text === text,
							),
				),
		);
	try {
		await page.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
		await page.locator(".connect-overlay").waitFor({ state: "detached" });
		await startNewSession(page);
		const inputA = page.locator("#input");
		await inputA.fill("hello");
		await page.locator("#send").click();
		await expect(page).toHaveURL(/\/s\/ses_/);
		sessionUrl = page.url();
		sessionId = new URL(sessionUrl).pathname.split("/").at(-1);
		await inputA.fill(draft);
		await expect
			.poll(() => completed(callsA, "SyncInputDraft", draft))
			.toBe(true);
		await page.screenshot({ path: testInfo.outputPath("draft-written-A.png") });

		// Stop A's reconnect code so it cannot re-send a local draft after restart.
		await page.goto("about:blank");
		await buildDaemon.restart(buildDaemon.buildId);
		contextB = await browser.newContext({
			viewport: page.viewportSize(),
			isMobile: testInfo.project.use.isMobile ?? false,
			hasTouch: testInfo.project.use.hasTouch ?? false,
		});
		pageB = await contextB.newPage();
		callsB = captureDraftCalls(pageB);
		await pageB.goto(sessionUrl);
		await expect
			.poll(() => completed(callsB, "SubscribeInputDraft", draft))
			.toBe(true);
		const inputB = pageB.locator("#input");
		await expect(inputB).toHaveValue(draft);
		await pageB.screenshot({
			path: testInfo.outputPath("draft-restored-new-device-B.png"),
		});

		await page.goto(sessionUrl);
		await expect(inputA).toHaveValue(draft);
		await pageB.locator("#send").click();
		await expect(inputA).toHaveValue("");
		await expect(inputB).toHaveValue("");
		const beforeClearA = callsA.length;
		const beforeClearB = callsB.length;
		await page.reload();
		await pageB.reload();
		await expect
			.poll(() =>
				completed(callsA.slice(beforeClearA), "SubscribeInputDraft", ""),
			)
			.toBe(true);
		await expect
			.poll(() =>
				completed(callsB.slice(beforeClearB), "SubscribeInputDraft", ""),
			)
			.toBe(true);

		await page.goto("about:blank");
		await pageB.goto("about:blank");
		await buildDaemon.restart(buildDaemon.buildId);
		const beforeRestartA = callsA.length;
		const beforeRestartB = callsB.length;
		await page.goto(sessionUrl);
		await pageB.goto(sessionUrl);
		await expect
			.poll(() =>
				completed(callsA.slice(beforeRestartA), "SubscribeInputDraft", ""),
			)
			.toBe(true);
		await expect
			.poll(() =>
				completed(callsB.slice(beforeRestartB), "SubscribeInputDraft", ""),
			)
			.toBe(true);
		await expect(inputA).toHaveValue("");
		await expect(inputB).toHaveValue("");
	} finally {
		await Promise.allSettled([
			page.screenshot({ path: testInfo.outputPath("draft-final-A.png") }),
			...(pageB
				? [pageB.screenshot({ path: testInfo.outputPath("draft-final-B.png") })]
				: []),
		]);
		const path = testInfo.outputPath("session-draft-rpc-frames.json");
		writeFileSync(
			path,
			JSON.stringify(
				{ sessionUrl, sessionId, draft, A: callsA, B: callsB },
				null,
				2,
			),
		);
		await testInfo.attach("session-draft-rpc-frames", {
			path,
			contentType: "application/json",
		});
		await contextB?.close();
	}
});

for (const sameBuild of [true, false]) {
	test(`an existing session's draft survives a ${sameBuild ? "same-build" : "new-build"} daemon restart`, async ({
		page,
		buildDaemon,
	}, testInfo) => {
		// Hold the initial draft read so it arrives after local typing and reload.
		const frames = (m: string | Buffer) =>
			[JSON.parse(String(m))].flat() as Array<{
				tag?: string;
				id?: string;
				requestId?: string;
			}>;
		const viewIds = new Set<string>();
		await page.routeWebSocket(/\/rpc$/, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => {
				for (const f of frames(m))
					if (f.tag === "SubscribeInputDraft") viewIds.add(String(f.id));
				server.send(m);
			});
			server.onMessage((m) => {
				const held = frames(m).some((f) => viewIds.has(String(f.requestId)));
				setTimeout(() => ws.send(m), held ? 2_000 : 0);
			});
		});
		await page.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
		await page.locator(".connect-overlay").waitFor({ state: "detached" });
		await startNewSession(page);
		const input = page.locator("#input");
		await input.fill("hello");
		// Click, not Enter: Enter is a newline on mobile. Click also waits for
		// Send to enable, which happens once the provider can take a turn.
		await page.locator("#send").click();
		await expect(page).toHaveURL(/\/s\/ses_/);
		const draft = "Unsent draft on an existing session";
		await input.fill(draft);
		// Let the trailing throttle write reach the daemon before it stops.
		await page.waitForTimeout(1_000);
		await buildDaemon.restart(
			sameBuild ? buildDaemon.buildId : `${buildDaemon.buildId}-B`,
		);
		await page.locator(".connect-overlay").waitFor({ state: "detached" });
		await page.waitForTimeout(3_000);
		await expect(input).toHaveValue(draft);
		// Coming back to the session asks the restarted daemon for its draft again.
		const sessionUrl = page.url();
		const sessionId = new URL(sessionUrl).pathname.split("/").pop();
		const newSession = page.locator("#new-session-btn:visible");
		// On mobile the sidebar sits behind the Sessions button, and opening it
		// adds a history entry, so return through the session row, not goBack.
		const openSidebar = async () => {
			if (!(await newSession.isVisible()))
				await page.getByRole("button", { name: "Sessions" }).click();
		};
		await openSidebar();
		await newSession.click();
		await expect(page).toHaveURL(/\/draft\/[^/?]+\b/);
		await openSidebar();
		await page
			.locator(
				`#session-list [data-session-id="${sessionId}"] .session-item-title`,
			)
			.click();
		await expect(page).toHaveURL(sessionUrl);
		await page.waitForTimeout(3_000);
		await page.screenshot({
			path: testInfo.outputPath("existing-session-draft.png"),
		});
		await expect(input).toHaveValue(draft);
	});
}

async function startNewSession(page: Page) {
	const button = page.locator("#new-session-btn:visible");
	if (!(await button.isVisible()))
		await page.getByRole("button", { name: "Sessions", exact: true }).click();
	await button.click();
	await expect(page).toHaveURL(/\/draft\/[^/?]+\b/);
}

async function createDraftSession(page: Page, baseUrl: string) {
	const calls = captureDraftCalls(page);
	await page.goto(`${baseUrl}/?p=build-id-test`);
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	await startNewSession(page);
	await page.locator("#input").fill("hello");
	await page.locator("#send").click();
	await expect(page).toHaveURL(/\/s\/ses_/);
	await expect(page.locator("#input")).toHaveValue("");
	const sessionId = new URL(page.url()).pathname.split("/").pop();
	await expect
		.poll(() =>
			calls.some(
				({ request, replies }) =>
					request.frame.tag === "SubscribeInputDraft" &&
					request.frame.payload?.key?.session === sessionId &&
					replies.some(({ frame }) =>
						frame.values?.some((value) => value._tag === "synchronized"),
					),
			),
		)
		.toBe(true);
	return page.url();
}

function syncCompleted(
	calls: ReturnType<typeof captureDraftCalls>,
	text: string,
) {
	return calls.some(
		({ request, replies }) =>
			request.frame.tag === "SyncInputDraft" &&
			request.frame.payload?.text === text &&
			replies.some(
				({ frame }) => frame._tag === "Exit" && frame.exit?._tag === "Success",
			),
	);
}

async function saveDraftEvidence(
	testInfo: TestInfo,
	pages: Page[],
	evidence: object,
) {
	await Promise.allSettled(
		pages.map((page, index) =>
			page.screenshot({
				path: testInfo.outputPath(`draft-device-${index}.png`),
			}),
		),
	);
	const path = testInfo.outputPath("draft-rpc-frames.json");
	writeFileSync(path, JSON.stringify(evidence, null, 2));
	await testInfo.attach("draft-rpc-frames", {
		path,
		contentType: "application/json",
	});
}

async function readDaemonSessionIds(baseUrl: string): Promise<string[]> {
	const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/rpc`);
	try {
		return await new Promise<string[]>((resolve, reject) => {
			socket.once("open", () =>
				socket.send(
					JSON.stringify({
						_tag: "Request",
						id: "sessions",
						tag: "ListDaemonSessions",
						payload: {
							_tag: "ListDaemonSessions",
							projectSlug: "build-id-test",
							limit: 100,
						},
						headers: [],
					}),
				),
			);
			socket.on("message", (data) => {
				const frames = [JSON.parse(String(data))].flat() as Array<{
					_tag?: string;
					requestId?: string;
					exit?: {
						_tag?: string;
						value?: { sessions?: Array<{ id: string }> };
					};
				}>;
				for (const frame of frames) {
					if (frame._tag !== "Exit" || frame.requestId !== "sessions") continue;
					if (frame.exit?._tag !== "Success" || !frame.exit.value?.sessions)
						reject(new Error(`ListDaemonSessions failed: ${String(data)}`));
					else resolve(frame.exit.value.sessions.map(({ id }) => id));
				}
			});
			socket.once("error", reject);
			socket.once("close", () => reject(new Error("No daemon session list")));
		});
	} finally {
		if (socket.readyState !== WebSocket.CLOSED) {
			const closed = once(socket, "close");
			socket.close();
			await closed;
		}
	}
}

function receivedDraftLists(calls: ReturnType<typeof captureDraftCalls>) {
	type Row = {
		draftId: string;
		projectSlug: string;
		firstLine: string;
		updatedAt: number;
	};
	return calls
		.filter(({ request }) => request.frame.tag === "SubscribeDrafts")
		.flatMap(({ replies }) =>
			replies.flatMap(({ at, frame }) =>
				frame._tag !== "Chunk"
					? []
					: (frame.values ?? []).flatMap((value) =>
							Array.isArray(value) ? [{ at, drafts: value as Row[] }] : [],
						),
			),
		);
}

async function showDraftSidebar(page: Page) {
	const list = page.locator("#session-list");
	const sessions = page.getByRole("button", { name: "Sessions", exact: true });
	await expect
		.poll(async () => (await list.isVisible()) || (await sessions.isVisible()))
		.toBe(true);
	if (!(await list.isVisible())) await sessions.click();
	await expect(list).toBeVisible();
}

const draftSidebarRow = (page: Page, draftId: string) =>
	page.locator(`[data-testid="draft-row"][data-draft-id="${draftId}"]`);

test("scenario 2 restores a sidebar draft after restart and removes it on both devices after send", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	const text = "A durable sidebar draft to send from device B";
	let draftUrl = "";
	let sessionPath = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		const draftId = new URL(draftUrl).pathname.split("/").pop() ?? "";
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("sidebar-draft-written-A.png"),
		});
		await buildDaemon.restart(buildDaemon.buildId);
		await page.locator(".connect-overlay").waitFor({ state: "detached" });
		await expect(page.locator("#input")).toHaveValue(text);
		await pageB.goto(`${buildDaemon.baseUrl}/?p=build-id-other`);
		await showDraftSidebar(pageB);
		const rowB = draftSidebarRow(pageB, draftId);
		await expect
			.poll(() =>
				receivedDraftLists(callsB).some(({ drafts }) =>
					drafts.some(
						(draft) =>
							draft.draftId === draftId &&
							draft.projectSlug === "build-id-test" &&
							draft.firstLine === text,
					),
				),
			)
			.toBe(true);
		await expect(rowB).toHaveCount(0);
		await pageB.screenshot({
			path: testInfo.outputPath("sidebar-draft-other-project-filtered-B.png"),
		});
		await pageB.goto(`${buildDaemon.baseUrl}/`);
		await showDraftSidebar(pageB);
		await expect(rowB).toContainText(text);
		await pageB.screenshot({
			path: testInfo.outputPath("sidebar-draft-after-restart-B.png"),
		});
		await rowB.getByRole("link").click();
		await expect
			.poll(() => new URL(pageB.url()).pathname)
			.toBe(new URL(draftUrl).pathname);
		expect(new URL(pageB.url()).searchParams.get("project")).toBe(
			"build-id-test",
		);
		await expect(pageB.locator("#input")).toHaveValue(text);
		await pageB.screenshot({
			path: testInfo.outputPath("sidebar-draft-opened-B.png"),
		});
		await pageB.locator("#send").click();
		await expect(pageB).toHaveURL(/\/s\/ses_/);
		sessionPath = new URL(pageB.url()).pathname;
		await expect.poll(() => new URL(page.url()).pathname).toBe(sessionPath);
		await page.screenshot({
			path: testInfo.outputPath("sidebar-promotion-followed-A.png"),
		});
		for (const tab of [page, pageB]) {
			await showDraftSidebar(tab);
			await expect(draftSidebarRow(tab, draftId)).toHaveCount(0);
		}
		for (const calls of [callsA, callsB])
			await expect
				.poll(() => {
					const latest = receivedDraftLists(calls).at(-1);
					return (
						latest !== undefined &&
						!latest.drafts.some((draft) => draft.draftId === draftId)
					);
				})
				.toBe(true);
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			sessionPath,
			text,
			A: callsA,
			B: callsB,
		});
		await contextB.close();
	}
});

test("scenario 5 discarding a sidebar draft removes its row on the other device", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const text = "Discard this draft from every device";
	const dirtyText = `${text} unsent tail`;
	let droppedLeading = false;
	const routed: Array<{
		direction: string;
		at: number;
		data: string;
		dropped?: boolean;
	}> = [];
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((data) => {
			const frames = [JSON.parse(String(data))].flat() as Array<{
				tag?: string;
				payload?: { text?: string };
			}>;
			for (const frame of frames) {
				const dropped =
					!droppedLeading &&
					frame.tag === "SyncInputDraft" &&
					frame.payload?.text === `${text} `;
				if (dropped) droppedLeading = true;
				routed.push({
					direction: "sent",
					at: Date.now(),
					data: JSON.stringify(frame),
					dropped,
				});
				if (!dropped) server.send(JSON.stringify(frame));
			}
		});
		server.onMessage((data) => {
			routed.push({
				direction: "received",
				at: Date.now(),
				data: String(data),
			});
			ws.send(data);
		});
	});
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	let draftUrl = "";
	let activeComposer = false;
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		const draftId = new URL(draftUrl).pathname.split("/").pop() ?? "";
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await showDraftSidebar(page);
		await pageB.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
		await showDraftSidebar(pageB);
		await expect(draftSidebarRow(page, draftId)).toContainText(text);
		await expect(draftSidebarRow(pageB, draftId)).toContainText(text);
		await page.screenshot({
			path: testInfo.outputPath("sidebar-before-discard-A.png"),
		});
		await pageB.screenshot({
			path: testInfo.outputPath("sidebar-before-discard-B.png"),
		});
		activeComposer = await page.locator("#input").isVisible();
		if (activeComposer) {
			// One browser task keeps the dirty burst and discard inside the throttle
			// window. Dropping its leading write leaves the previous text acknowledged.
			await page.evaluate(
				({ text, dirtyText, draftId }) => {
					const input = document.querySelector<HTMLTextAreaElement>("#input");
					const discard = document.querySelector<HTMLButtonElement>(
						`[data-testid="draft-row"][data-draft-id="${draftId}"] [data-testid="draft-row-discard"]`,
					);
					if (!input || !discard)
						throw new Error("Missing active draft composer or discard action");
					for (const value of [`${text} `, dirtyText]) {
						input.value = value;
						input.dispatchEvent(
							new InputEvent("input", {
								bubbles: true,
								inputType: "insertText",
							}),
						);
					}
					discard.click();
				},
				{ text, dirtyText, draftId },
			);
			await expect.poll(() => droppedLeading).toBe(true);
		} else {
			// The phone list unmounts the composer, so it has no active trailing timer.
			await draftSidebarRow(page, draftId)
				.getByTestId("draft-row-discard")
				.click();
		}
		await expect
			.poll(() =>
				callsA.some(
					({ request, replies }) =>
						request.frame.tag === "SyncInputDraft" &&
						request.frame.payload?.key?.draft === draftId &&
						request.frame.payload?.text === "" &&
						replies.some(({ frame }) => frame.exit?._tag === "Success"),
				),
			)
			.toBe(true);
		// Cover the 300 ms trailing write and the next one-second list window.
		await page.waitForTimeout(1_500);
		for (const tab of [page, pageB]) {
			await expect(tab.locator("#session-list")).toBeVisible();
			await expect(draftSidebarRow(tab, draftId)).toHaveCount(0);
		}
		await expect
			.poll(() => {
				const latest = receivedDraftLists(callsB).at(-1);
				return (
					latest !== undefined &&
					!latest.drafts.some((draft) => draft.draftId === draftId)
				);
			})
			.toBe(true);
		if (activeComposer) {
			await expect(page.locator("#input")).toHaveValue("");
			expect(
				callsA.some(
					({ request }) =>
						request.frame.tag === "SyncInputDraft" &&
						request.frame.payload?.text === dirtyText,
				),
			).toBe(false);
		}
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			text,
			dirtyText,
			activeComposer,
			droppedLeading,
			routed,
			A: callsA,
			B: callsB,
		});
		await contextB.close();
	}
});

test("human-paced typing publishes sidebar draft lists about once a second with the final text", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	const text = "Human-paced draft list updates!".slice(0, 30);
	let measurement: object = {};
	let draftUrl = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		const draftId = new URL(draftUrl).pathname.split("/").pop() ?? "";
		await pageB.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
		await showDraftSidebar(pageB);
		await expect
			.poll(() => receivedDraftLists(callsB).length)
			.toBeGreaterThan(0);
		const before = receivedDraftLists(callsB).length;
		const startedAt = Date.now();
		await page.locator("#input").pressSequentially(text, { delay: 100 });
		const typedAt = Date.now();
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await expect
			.poll(
				() =>
					receivedDraftLists(callsB)
						.at(-1)
						?.drafts.find((draft) => draft.draftId === draftId)?.firstLine,
			)
			.toBe(text);
		const updates = receivedDraftLists(callsB).slice(before);
		const budget = Math.ceil((typedAt - startedAt) / 1_000) + 1;
		measurement = {
			startedAt,
			typedAt,
			characters: text.length,
			delay: 100,
			budget,
			count: updates.length,
			updates,
		};
		expect(text).toHaveLength(30);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates.length).toBeLessThanOrEqual(budget);
		expect(updates.some(({ at }) => at < typedAt)).toBe(true);
		await expect(draftSidebarRow(pageB, draftId)).toContainText(text);
		await page.screenshot({
			path: testInfo.outputPath("sidebar-paced-typing-A.png"),
		});
		await pageB.screenshot({
			path: testInfo.outputPath("sidebar-paced-final-B.png"),
		});
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			text,
			measurement,
			A: callsA,
			B: callsB,
		});
		await contextB.close();
	}
});

test("sending a shared draft moves the matching device to the created session", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	const text = "Send this shared new-session draft once";
	let draftUrl = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await pageB.goto(draftUrl);
		await expect(pageB.locator("#input")).toHaveValue(text);
		await page.screenshot({
			path: testInfo.outputPath("matching-before-send-A.png"),
		});
		await pageB.screenshot({
			path: testInfo.outputPath("matching-before-send-B.png"),
		});
		await pageB.locator("#send").click();
		await expect(pageB).toHaveURL(/\/s\/ses_/);
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toBe(new URL(pageB.url()).pathname);
		await expect(page.locator("#input")).toHaveValue("");
		await expect(pageB.locator("#input")).toHaveValue("");
		const sessionId = new URL(pageB.url()).pathname.split("/").pop();
		expect(
			callsA.some(({ replies }) =>
				replies.some(({ frame }) =>
					frame.values?.some(
						(value) =>
							value._tag === "promoted" &&
							value.sessionId === sessionId &&
							value.text === text,
					),
				),
			),
		).toBe(true);
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			text,
			A: callsA,
			B: callsB,
		});
		await contextB.close();
	}
});

test("scenario 2b keeps another device's unsent edits under a fresh draft ID", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	let oldDraftId = "";
	const routed: Array<{
		direction: string;
		at: number;
		data: string;
		dropped?: boolean;
	}> = [];
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((data) => {
			const frames = [JSON.parse(String(data))].flat() as Array<{
				tag?: string;
				payload?: { key?: { draft?: string } };
			}>;
			for (const frame of frames) {
				const dropped =
					frame.tag === "SyncInputDraft" &&
					!!oldDraftId &&
					frame.payload?.key?.draft === oldDraftId;
				routed.push({
					direction: "sent",
					at: Date.now(),
					data: JSON.stringify(frame),
					dropped,
				});
				if (!dropped) server.send(JSON.stringify(frame));
			}
		});
		server.onMessage((data) => {
			routed.push({
				direction: "received",
				at: Date.now(),
				data: String(data),
			});
			ws.send(data);
		});
	});
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const pageC = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	const callsC = captureDraftCalls(pageC);
	const text = "The shared text B sends";
	const localText = `${text}; A is still adding an unsent thought`;
	let draftUrl = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await pageB.goto(draftUrl);
		await expect(pageB.locator("#input")).toHaveValue(text);
		oldDraftId = new URL(draftUrl).pathname.split("/").pop() ?? "";
		await page.locator("#input").fill(localText);
		await expect.poll(() => routed.some(({ dropped }) => dropped)).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("diverged-unsent-A.png"),
		});
		await pageB.locator("#send").click();
		await expect(pageB).toHaveURL(/\/s\/ses_/);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		await expect
			.poll(() => new URL(page.url()).pathname)
			.not.toBe(new URL(draftUrl).pathname);
		await expect(page.locator("#input")).toHaveValue(localText);
		expect(new URL(page.url()).searchParams.get("project")).toBe(
			"build-id-test",
		);
		const newDraftId = new URL(page.url()).pathname.split("/").pop();
		await expect
			.poll(() =>
				callsA.some(
					({ request, replies }) =>
						request.frame.tag === "SyncInputDraft" &&
						request.frame.payload?.key?.draft === newDraftId &&
						request.frame.payload?.text === localText &&
						replies.some(({ frame }) => frame.exit?._tag === "Success"),
				),
			)
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("diverged-fresh-draft-A.png"),
		});
		// The durable tombstone redirects an old link without reviving its text.
		await pageC.goto(draftUrl);
		await expect
			.poll(() => new URL(pageC.url()).pathname)
			.toBe(new URL(pageB.url()).pathname);
		await expect(pageC.locator("#input")).toHaveValue("");
		const sessionId = new URL(pageB.url()).pathname.split("/").pop();
		await expect
			.poll(() =>
				callsC.some(
					({ request, replies }) =>
						request.frame.payload?.key?.draft === oldDraftId &&
						replies.some(({ frame }) =>
							frame.values?.some(
								(value) =>
									value._tag === "synchronized" &&
									value.text === undefined &&
									value.promotedSessionId === sessionId,
							),
						),
				),
			)
			.toBe(true);
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB, pageC], {
			draftUrl,
			oldDraftId,
			text,
			localText,
			A: callsA,
			B: callsB,
			reopened: callsC,
			routed,
		});
		await contextB.close();
	}
});

test("near-simultaneous draft sends create one session and show the loser a toast", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const pendingCreates: Array<() => void> = [];
	const pendingPromotions: Array<() => void> = [];
	let releasePromotions = false;
	const routed: Array<{
		device: string;
		direction: string;
		at: number;
		data: string;
		held?: boolean;
	}> = [];
	const route = async (device: string, tab: Page) =>
		tab.routeWebSocket(/\/rpc$/, (ws) => {
			const server = ws.connectToServer();
			type Frame = { tag?: string; values?: Array<{ _tag?: string }> };
			ws.onMessage((data) => {
				for (const frame of [JSON.parse(String(data))].flat() as Frame[]) {
					const held = frame.tag === "CreateSession";
					routed.push({
						device,
						direction: "sent",
						at: Date.now(),
						data: JSON.stringify(frame),
						held,
					});
					if (held)
						pendingCreates.push(() => server.send(JSON.stringify(frame)));
					else server.send(JSON.stringify(frame));
				}
			});
			server.onMessage((data) => {
				for (const frame of [JSON.parse(String(data))].flat() as Frame[]) {
					const promotions =
						frame.values?.filter((value) => value._tag === "promoted") ?? [];
					routed.push({
						device,
						direction: "received",
						at: Date.now(),
						data: JSON.stringify(frame),
						held: promotions.length > 0,
					});
					if (!promotions.length || releasePromotions)
						ws.send(JSON.stringify(frame));
					else {
						pendingPromotions.push(() =>
							ws.send(JSON.stringify({ ...frame, values: promotions })),
						);
						const others = frame.values?.filter(
							(value) => value._tag !== "promoted",
						);
						if (others?.length)
							ws.send(JSON.stringify({ ...frame, values: others }));
					}
				}
			});
		});
	await route("A", page);
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	await route("B", pageB);
	const callsB = captureDraftCalls(pageB);
	const text = "One shared draft, one created session";
	let draftUrl = "";
	let before: string[] = [];
	let after: string[] = [];
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		await pageB.goto(draftUrl);
		await expect(pageB.locator("#input")).toHaveValue(text);
		before = await readDaemonSessionIds(buildDaemon.baseUrl);
		await Promise.all([
			page.locator("#send").click(),
			pageB.locator("#send").click(),
		]);
		await expect.poll(() => pendingCreates.length).toBe(2);
		for (const send of pendingCreates.splice(0)) send();
		const creates = () =>
			[...callsA, ...callsB].filter(
				({ request }) => request.frame.tag === "CreateSession",
			);
		await expect
			.poll(
				() =>
					creates().filter(({ replies }) =>
						replies.some(({ frame }) => frame._tag === "Exit"),
					).length,
			)
			.toBe(2);
		const successful = creates().filter(({ replies }) =>
			replies.some(({ frame }) => frame.exit?._tag === "Success"),
		);
		const failed = creates().filter(({ replies }) =>
			JSON.stringify(replies).includes("DraftAlreadySent"),
		);
		expect(successful).toHaveLength(1);
		expect(failed).toHaveLength(1);
		const loser = callsA.some((call) => call === failed[0]) ? page : pageB;
		await expect(
			loser
				.getByTestId("toast")
				.filter({ hasText: "This draft was already sent" }),
		).toBeVisible();
		await loser.screenshot({
			path: testInfo.outputPath("double-send-loser-toast.png"),
		});
		// The mock OpenCode server also surfaces its recorded session once a create
		// triggers discovery, so name the created session from the winning reply.
		const winner = JSON.stringify(successful[0]?.replies).match(
			/"sessionId":"(ses_[^"]+)"/,
		)?.[1];
		expect(winner).toBeDefined();
		after = await readDaemonSessionIds(buildDaemon.baseUrl);
		expect(after.filter((id) => !before.includes(id))).toContain(winner);
		const created = [winner];
		await expect.poll(() => pendingPromotions.length).toBeGreaterThan(0);
		releasePromotions = true;
		for (const send of pendingPromotions.splice(0)) send();
		for (const tab of [page, pageB]) {
			await expect(tab).toHaveURL(new RegExp(`/s/${created[0]}(?:\\?|$)`));
			await expect(tab.locator("#input")).toHaveValue("");
		}
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			text,
			before,
			after,
			A: callsA,
			B: callsB,
			routed,
		});
		await contextB.close();
	}
});

test("a failed session create releases the claim and keeps the shared draft text", async ({
	page,
	buildDaemon,
}, testInfo) => {
	const calls = captureDraftCalls(page);
	const text = "Keep this draft after the provider refuses session creation";
	let draftUrl = "";
	let before: string[] = [];
	let after: string[] = [];
	buildDaemon.failSessionCreates();
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		draftUrl = page.url();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(calls, text)).toBe(true);
		before = await readDaemonSessionIds(buildDaemon.baseUrl);
		for (const attempt of [1, 2]) {
			await page.locator("#send").click();
			await expect
				.poll(
					() =>
						calls.filter(
							({ request, replies }) =>
								request.frame.tag === "CreateSession" &&
								replies.some(({ frame }) => frame.exit?._tag === "Failure"),
						).length,
				)
				.toBe(attempt);
			await expect(
				page
					.getByTestId("toast")
					.filter({ hasText: "Failed to create session" })
					.first(),
			).toBeVisible();
			await expect(
				page
					.getByTestId("toast")
					.filter({ hasText: "This draft was already sent" }),
			).toHaveCount(0);
			await expect(page).toHaveURL(draftUrl);
			await expect(page.locator("#input")).toHaveValue(text);
			await page.screenshot({
				path: testInfo.outputPath(`create-failed-${attempt}.png`),
			});
			if (attempt === 1) {
				await page.reload();
				await expect(page.locator("#input")).toHaveValue(text);
				await page.screenshot({
					path: testInfo.outputPath("create-failed-reloaded-draft.png"),
				});
			}
		}
		after = await readDaemonSessionIds(buildDaemon.baseUrl);
		expect(after.sort()).toEqual(before.sort());
		expect(JSON.stringify(calls)).not.toContain("DraftAlreadySent");
	} finally {
		await saveDraftEvidence(testInfo, [page], {
			draftUrl,
			text,
			before,
			after,
			calls,
		});
	}
});

test("a new-session draft survives a daemon restart for a device opening its URL", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	const text = "A new-session draft persisted across the daemon restart";
	let draftUrl = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?project=build-id-test/);
		draftUrl = page.url();
		const draftId = new URL(draftUrl).pathname.split("/").pop();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(callsA, text)).toBe(true);
		expect(
			callsA.some(
				({ request }) => request.frame.payload?.key?.draft === draftId,
			),
		).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("new-draft-written-A.png"),
		});
		// The second device must read the durable row, without A reconnecting
		// and writing its in-memory copy back after the restart.
		await page.goto("about:blank");
		await buildDaemon.restart(buildDaemon.buildId);
		await pageB.goto(draftUrl);
		await expect(pageB.locator("#input")).toHaveValue(text);
		await expect
			.poll(() =>
				callsB.some(
					({ request, replies }) =>
						request.frame.tag === "SubscribeInputDraft" &&
						request.frame.payload?.key?.draft === draftId &&
						replies.some(({ frame }) =>
							frame.values?.some(
								(value) =>
									value._tag === "synchronized" &&
									value.text === text &&
									value.projectId === "build-id-test",
							),
						),
				),
			)
			.toBe(true);
		// A bare link must discover the stored project instead of moving the row
		// to whichever project this new device currently defaults to.
		const bareDraftUrl = new URL(draftUrl);
		bareDraftUrl.search = "";
		await pageB.goto(bareDraftUrl.href);
		await expect(pageB.locator("#input")).toHaveValue(text);
		await expect
			.poll(() => new URL(pageB.url()).searchParams.get("project"))
			.toBe("build-id-test");
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			draftUrl,
			text,
			A: callsA,
			B: callsB,
		});
		await contextB.close();
	}
});

test("New session twice opens independent empty draft URLs", async ({
	page,
	buildDaemon,
}, testInfo) => {
	const calls = captureDraftCalls(page);
	const urls: string[] = [];
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		await expect(page.locator("#input")).toHaveValue("");
		const entry = page.url();
		urls.push(entry);
		await page.screenshot({
			path: testInfo.outputPath("empty-draft-entry.png"),
		});
		for (const index of [1, 2]) {
			await startNewSession(page);
			urls.push(page.url());
			expect(new Set(urls.map((url) => new URL(url).pathname)).size).toBe(
				urls.length,
			);
			await expect(page.locator("#input")).toHaveValue("");
			await page.screenshot({
				path: testInfo.outputPath(`empty-draft-new-${index}.png`),
			});
		}
	} finally {
		await saveDraftEvidence(testInfo, [page], { urls, calls });
	}
});

test("the legacy localStorage new-session draft migrates once into a fresh server draft", async ({
	page,
	buildDaemon,
}, testInfo) => {
	const calls = captureDraftCalls(page);
	const text =
		"Legacy browser draft from before the server-stored draft upgrade";
	let previousUrl = "";
	let migratedUrl = "";
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		previousUrl = page.url();
		await page.evaluate((value) => {
			localStorage.setItem("conduit:new-session-draft", value);
		}, text);
		await page.screenshot({
			path: testInfo.outputPath("legacy-before-upgrade.png"),
		});
		await page.reload();
		await expect(page.locator("#input")).toHaveValue(text);
		migratedUrl = page.url();
		expect(new URL(migratedUrl).pathname).not.toBe(
			new URL(previousUrl).pathname,
		);
		await expect.poll(() => syncCompleted(calls, text)).toBe(true);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("conduit:new-session-draft"),
			),
		).toBeNull();
		await page.screenshot({
			path: testInfo.outputPath("legacy-migrated-draft.png"),
		});
		const migrationCalls = calls.length;
		await page.reload();
		await expect(page).toHaveURL(migratedUrl);
		await expect(page.locator("#input")).toHaveValue(text);
		await expect
			.poll(() =>
				calls
					.slice(migrationCalls)
					.some(
						({ request, replies }) =>
							request.frame.tag === "SubscribeInputDraft" &&
							replies.some(({ frame }) =>
								frame.values?.some(
									(value) =>
										value._tag === "synchronized" && value.text === text,
								),
							),
					),
			)
			.toBe(true);
	} finally {
		await saveDraftEvidence(testInfo, [page], {
			previousUrl,
			migratedUrl,
			text,
			calls,
		});
	}
});

test("moving a draft between projects keeps its text and draft ID", async ({
	page,
	buildDaemon,
}, testInfo) => {
	const calls = captureDraftCalls(page);
	const text = "Keep this draft while moving between projects";
	const urls: string[] = [];
	try {
		await page.goto(`${buildDaemon.baseUrl}/new?project=build-id-test`);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		const draftPath = new URL(page.url()).pathname;
		const draftId = draftPath.split("/").pop();
		await page.locator("#input").fill(text);
		await expect.poll(() => syncCompleted(calls, text)).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("draft-first-project.png"),
		});
		for (const project of ["build-id-other", "build-id-test"]) {
			const beforeMove = calls.length;
			await page.getByTestId("draft-project-chip").click();
			await page
				.getByRole("menuitemradio", { name: project, exact: true })
				.click();
			await expect(page).toHaveURL(
				`${buildDaemon.baseUrl}${draftPath}?project=${project}`,
			);
			await expect(page.locator("#input")).toHaveValue(text);
			await expect
				.poll(() =>
					calls
						.slice(beforeMove)
						.some(
							({ request, replies }) =>
								request.frame.tag === "SyncInputDraft" &&
								request.frame.payload?.key?.draft === draftId &&
								request.frame.payload?.projectSlug === project &&
								request.frame.payload?.text === text &&
								replies.some(
									({ frame }) =>
										frame._tag === "Exit" && frame.exit?._tag === "Success",
								),
						),
				)
				.toBe(true);
			urls.push(page.url());
			await page.screenshot({
				path: testInfo.outputPath(`draft-moved-${project}.png`),
			});
			const beforeReload = calls.length;
			await page.reload();
			await expect(page.locator("#input")).toHaveValue(text);
			await expect(page.getByTestId("draft-project-chip")).toContainText(
				project,
			);
			await expect
				.poll(() =>
					calls
						.slice(beforeReload)
						.some(
							({ request, replies }) =>
								request.frame.tag === "SubscribeInputDraft" &&
								request.frame.payload?.key?.draft === draftId &&
								replies.some(({ frame }) =>
									frame.values?.some(
										(value) =>
											value._tag === "synchronized" &&
											value.projectId === project,
									),
								),
						),
				)
				.toBe(true);
			await page.screenshot({
				path: testInfo.outputPath(`draft-reloaded-${project}.png`),
			});
		}
	} finally {
		await saveDraftEvidence(testInfo, [page], { text, urls, calls });
	}
});

// These drive the real browser/daemon wire. No component or machine internals.
for (const serverWins of [false, true]) {
	test(`a build reload keeps the ${serverWins ? "server's newer edit" : "unsynced local tail"}`, async ({
		page,
		browser,
		buildDaemon,
	}, testInfo) => {
		test.setTimeout(90_000);
		const baseline = "The last acknowledged draft";
		const localText = `${baseline}, plus an unsynced local tail`;
		const serverText = "Device B edited this draft during A's reload";
		let dropTail = true;
		let reloadRequested = false;
		let releaseReload = () => {};
		const reloadGate = new Promise<void>((resolve) => {
			releaseReload = resolve;
		});
		const routed: Array<{
			document: string;
			direction: string;
			at: number;
			data: string;
			dropped?: boolean;
		}> = [];
		await page.routeWebSocket(/\/rpc$/, (ws) => {
			const document = reloadRequested ? "reloaded" : "original";
			const server = ws.connectToServer();
			ws.onMessage((data) => {
				const parsed = JSON.parse(String(data)) as unknown;
				const frames = [parsed].flat() as Array<{
					tag?: string;
					payload?: { text?: string };
				}>;
				const forwarded = frames.filter((frame) => {
					const dropped =
						dropTail &&
						frame.tag === "SyncInputDraft" &&
						frame.payload?.text === localText;
					routed.push({
						document,
						direction: "sent",
						at: Date.now(),
						data: JSON.stringify(frame),
						dropped,
					});
					return !dropped;
				});
				if (forwarded.length === frames.length) server.send(data);
				else if (forwarded.length)
					server.send(
						JSON.stringify(Array.isArray(parsed) ? forwarded : forwarded[0]),
					);
			});
			server.onMessage((data) => {
				routed.push({
					document,
					direction: "received",
					at: Date.now(),
					data: String(data),
				});
				ws.send(data);
			});
		});
		const callsA = captureDraftCalls(page);
		const contextB = await browser.newContext({
			viewport: page.viewportSize(),
			isMobile: testInfo.project.use.isMobile ?? false,
			hasTouch: testInfo.project.use.hasTouch ?? false,
		});
		const pageB = await contextB.newPage();
		const callsB = captureDraftCalls(pageB);
		let sessionUrl = "";
		try {
			sessionUrl = await createDraftSession(page, buildDaemon.baseUrl);
			const input = page.locator("#input");
			await input.fill(baseline);
			await expect.poll(() => syncCompleted(callsA, baseline)).toBe(true);
			await input.fill(localText);
			await expect.poll(() => routed.some((frame) => frame.dropped)).toBe(true);
			await page.screenshot({
				path: testInfo.outputPath("reload-unsynced-local-tail.png"),
			});
			// Pause after persistInputDraft saved the backup, before the new shell
			// can subscribe. Dropped requests never receive a fabricated success.
			await page.route(
				(url) => url.href === sessionUrl,
				async (route) => {
					if (route.request().isNavigationRequest() && !reloadRequested) {
						reloadRequested = true;
						await reloadGate;
					}
					await route.continue();
				},
			);
			await buildDaemon.restart(`${buildDaemon.buildId}-B`);
			await expect.poll(() => reloadRequested).toBe(true);
			dropTail = false;
			if (serverWins) {
				await pageB.goto(sessionUrl);
				await expect(
					pageB.locator(".banner-text", { hasText: "different builds" }),
				).toBeVisible();
				await expect(pageB.locator("#input")).toHaveValue(baseline);
				await pageB.locator("#input").fill(serverText);
				await expect.poll(() => syncCompleted(callsB, serverText)).toBe(true);
				await pageB.screenshot({
					path: testInfo.outputPath("reload-newer-server-draft-B.png"),
				});
			}
			releaseReload();
			const expected = serverWins ? serverText : localText;
			await expect(
				page.locator(".banner-text", { hasText: "different builds" }),
			).toBeVisible();
			await expect(input).toHaveValue(expected);
			if (!serverWins) {
				await expect.poll(() => syncCompleted(callsA, localText)).toBe(true);
				await pageB.goto(sessionUrl);
			}
			await expect
				.poll(() =>
					(serverWins ? callsA : callsB).some(
						({ request, replies }) =>
							request.frame.tag === "SubscribeInputDraft" &&
							replies.some(({ frame }) =>
								frame.values?.some(
									(value) =>
										value._tag === "synchronized" && value.text === expected,
								),
							),
					),
				)
				.toBe(true);
			await expect(pageB.locator("#input")).toHaveValue(expected);
			await page.waitForTimeout(600);
			await expect(input).toHaveValue(expected);
			if (serverWins)
				expect(
					routed.some((frame) => {
						if (frame.document !== "reloaded" || frame.direction !== "sent")
							return false;
						const message = JSON.parse(frame.data) as {
							tag?: string;
							payload?: { text?: string };
						};
						return (
							message.tag === "SyncInputDraft" &&
							message.payload?.text === localText
						);
					}),
				).toBe(false);
		} finally {
			releaseReload();
			await saveDraftEvidence(testInfo, [page, pageB], {
				sessionUrl,
				serverWins,
				baseline,
				localText,
				serverText,
				A: callsA,
				B: callsB,
				routed,
			});
			await contextB.close();
		}
	});
}

test("offline typing survives a cut WebSocket and a delayed stored draft", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	test.setTimeout(90_000);
	let offline = false;
	const sockets = new Map<WebSocketRoute, WebSocketRoute>();
	const routed: Array<{ direction: string; at: number; data: string }> = [];
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		if (offline) {
			ws.close({ code: 1001 });
			return;
		}
		const server = ws.connectToServer();
		sockets.set(ws, server);
		const draftIds = new Set<string>();
		ws.onMessage((data) => {
			routed.push({ direction: "sent", at: Date.now(), data: String(data) });
			for (const frame of [JSON.parse(String(data))].flat() as Array<{
				tag?: string;
				id?: string;
			}>)
				if (frame.tag === "SubscribeInputDraft") draftIds.add(String(frame.id));
			server.send(data);
		});
		server.onMessage((data) => {
			routed.push({
				direction: "received",
				at: Date.now(),
				data: String(data),
			});
			const snapshot = (
				[JSON.parse(String(data))].flat() as Array<{
					requestId?: string;
					values?: Array<{ _tag: string }>;
				}>
			).some(
				(frame) =>
					draftIds.has(String(frame.requestId)) &&
					frame.values?.some((value) => value._tag === "synchronized"),
			);
			setTimeout(() => ws.send(data), snapshot ? 1_200 : 0);
		});
	});
	const calls = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	let sessionUrl = "";
	const text = "Offline typing must survive every server answer";
	try {
		sessionUrl = await createDraftSession(page, buildDaemon.baseUrl);
		await page.locator("#input").fill("older stored draft");
		await expect
			.poll(() => syncCompleted(calls, "older stored draft"))
			.toBe(true);
		offline = true;
		for (const [client, server] of sockets) {
			client.close({ code: 1001 });
			server.close({ code: 1001 });
		}
		await expect(page.locator(".connect-overlay")).toBeVisible();
		await page.locator("#input").fill(text);
		await page.screenshot({ path: testInfo.outputPath("offline-typed.png") });
		offline = false;
		await page.locator(".connect-overlay").waitFor({ state: "detached" });
		await expect.poll(() => syncCompleted(calls, text)).toBe(true);
		await page.waitForTimeout(1_500);
		await expect(page.locator("#input")).toHaveValue(text);
		await pageB.goto(sessionUrl);
		await expect(pageB.locator("#input")).toHaveValue(text);
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			sessionUrl,
			text,
			calls,
			callsB,
			routed,
		});
		await contextB.close();
	}
});

declare global {
	interface Window {
		draftPerformance?: { longTasks: number[]; observer: PerformanceObserver };
		draftPaints?: Array<{ at: number; path: string; text: string }>;
	}
}

test(
	"500 human-paced characters stay responsive within the 300 ms throttle budget",
	{ tag: "@timed" },
	async ({ page, buildDaemon }, testInfo) => {
		test.setTimeout(90_000);
		const calls = captureDraftCalls(page);
		let measurement: object = {};
		try {
			await createDraftSession(page, buildDaemon.baseUrl);
			await page.waitForTimeout(1_000);
			await page.evaluate(() => {
				if (!PerformanceObserver.supportedEntryTypes.includes("longtask"))
					throw new Error("longtask observer unavailable");
				const longTasks: number[] = [];
				const observer = new PerformanceObserver((list) => {
					for (const task of list.getEntries()) longTasks.push(task.duration);
				});
				observer.observe({ type: "longtask" });
				window.draftPerformance = { longTasks, observer };
			});
			const start = Date.now();
			const before = calls.length;
			const text = "A human keeps typing while the draft saves live. "
				.repeat(11)
				.slice(0, 500);
			await page.locator("#input").pressSequentially(text, { delay: 100 });
			const typedAt = Date.now();
			await expect
				.poll(() => syncCompleted(calls.slice(before), text))
				.toBe(true);
			const longTasks = await page.evaluate(() => {
				window.draftPerformance?.observer.disconnect();
				return window.draftPerformance?.longTasks ?? [];
			});
			const syncs = calls
				.slice(before)
				.filter((call) => call.request.frame.tag === "SyncInputDraft");
			const budget = Math.floor((typedAt - start) / 300) + 2;
			measurement = {
				start,
				typedAt,
				characters: text.length,
				delay: 100,
				budget,
				count: syncs.length,
				longTasks,
			};
			await expect(page.locator("#input")).toHaveValue(text);
			expect(syncs.length).toBeGreaterThan(2);
			expect(syncs.length).toBeLessThanOrEqual(budget);
			expect(syncs[0]?.request.at).toBeLessThan(start + 300);
			expect(longTasks.filter((duration) => duration > 50)).toEqual([]);
		} finally {
			await saveDraftEvidence(testInfo, [page], { measurement, calls });
		}
	},
);

for (const event of ["visibilitychange", "pagehide"] as const) {
	test(`${event} flushes the latest text mid-burst`, async ({
		page,
		buildDaemon,
	}, testInfo) => {
		const calls = captureDraftCalls(page);
		let hiddenAt = 0;
		const text = `Latest text flushed on ${event}`;
		try {
			await createDraftSession(page, buildDaemon.baseUrl);
			// Both input events and hide happen in the same browser task, before the
			// 300ms timer can fire. Chromium has no CDP command to hide a test tab.
			await page.locator("#input").evaluate(
				(node, { text, event }) => {
					const input = node as HTMLTextAreaElement;
					input.value = "leading";
					input.dispatchEvent(new Event("input", { bubbles: true }));
					input.value = text;
					input.dispatchEvent(new Event("input", { bubbles: true }));
					if (event === "visibilitychange") {
						Object.defineProperty(document, "visibilityState", {
							configurable: true,
							value: "hidden",
						});
						document.dispatchEvent(new Event("visibilitychange"));
					}
					// A persisted pagehide is iOS backgrounding a PWA: the page lives on.
					// On a real unload ChatLayout disposes the RPC runtime, so nothing
					// async can be sent; the reload backup covers that case.
					else
						window.dispatchEvent(
							new PageTransitionEvent("pagehide", { persisted: true }),
						);
				},
				{ text, event },
			);
			hiddenAt = Date.now();
			await expect.poll(() => syncCompleted(calls, text)).toBe(true);
			const leading = calls.find(
				(call) => call.request.frame.payload?.text === "leading",
			);
			const flushed = calls.find(
				(call) => call.request.frame.payload?.text === text,
			);
			expect(leading).toBeDefined();
			expect(flushed).toBeDefined();
			expect(
				(flushed?.request.at ?? Infinity) - (leading?.request.at ?? 0),
			).toBeLessThan(300);
			await page.reload();
			await expect(page.locator("#input")).toHaveValue(text);
		} finally {
			await saveDraftEvidence(testInfo, [page], {
				event,
				hiddenAt,
				text,
				calls,
			});
		}
	});
}

test("two tabs on the same session exchange drafts live", async ({
	page,
	context,
	buildDaemon,
}, testInfo) => {
	const callsA = captureDraftCalls(page);
	const pageB = await context.newPage();
	const callsB = captureDraftCalls(pageB);
	try {
		const url = await createDraftSession(page, buildDaemon.baseUrl);
		await pageB.goto(url);
		await expect(pageB.locator("#input")).toBeVisible();
		await page.locator("#input").fill("Typed in tab A");
		await expect(pageB.locator("#input")).toHaveValue("Typed in tab A");
		await page.screenshot({ path: testInfo.outputPath("live-from-A.png") });
		await pageB.locator("#input").fill("Continued in tab B");
		await expect(page.locator("#input")).toHaveValue("Continued in tab B");
		await expect
			.poll(() => syncCompleted(callsB, "Continued in tab B"))
			.toBe(true);
		await pageB.locator("#input").fill("");
		await expect(page.locator("#input")).toHaveValue("");
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], { A: callsA, B: callsB });
		await pageB.close();
	}
});

test("switching sessions restores stored drafts and records each painted composer", async ({
	page,
	browser,
	buildDaemon,
}, testInfo) => {
	test.setTimeout(90_000);
	const callsA = captureDraftCalls(page);
	const contextB = await browser.newContext({
		viewport: page.viewportSize(),
		isMobile: testInfo.project.use.isMobile ?? false,
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const pageB = await contextB.newPage();
	const callsB = captureDraftCalls(pageB);
	let paints: NonNullable<Window["draftPaints"]> = [];
	try {
		const first = await createDraftSession(page, buildDaemon.baseUrl);
		await page.locator("#input").fill("First stored draft");
		await expect
			.poll(() => syncCompleted(callsA, "First stored draft"))
			.toBe(true);
		await startNewSession(page);
		await page.locator("#input").fill("hello again");
		await page.locator("#send").click();
		await expect(page).toHaveURL(/\/s\/ses_/);
		const second = page.url();
		expect(second).not.toBe(first);
		await page.locator("#input").fill("Second stored draft");
		await expect
			.poll(() => syncCompleted(callsA, "Second stored draft"))
			.toBe(true);
		await pageB.goto(first);
		await expect(pageB.locator("#input")).toHaveValue("First stored draft");
		await pageB.screenshot({ path: testInfo.outputPath("switch-1-first.png") });
		await pageB.evaluate(() => {
			window.draftPaints = [];
			const sample = () => {
				const input = document.querySelector<HTMLTextAreaElement>("#input");
				if (input && window.draftPaints)
					window.draftPaints.push({
						at: performance.now(),
						path: location.pathname,
						text: input.value,
					});
				requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		const switchTo = async (url: string) => {
			const id = new URL(url).pathname.split("/").pop();
			if (!(await pageB.locator("#new-session-btn:visible").isVisible()))
				await pageB
					.getByRole("button", { name: "Sessions", exact: true })
					.click();
			await pageB
				.locator(`#session-list [data-session-id="${id}"] .session-item-title`)
				.click();
			await expect(pageB).toHaveURL(url);
		};
		await switchTo(second);
		await pageB.screenshot({
			path: testInfo.outputPath("switch-2-arrival.png"),
		});
		await expect(pageB.locator("#input")).toHaveValue("Second stored draft");
		await pageB.screenshot({
			path: testInfo.outputPath("switch-3-stored.png"),
		});
		await switchTo(first);
		await pageB.screenshot({
			path: testInfo.outputPath("switch-4-cached.png"),
		});
		await expect(pageB.locator("#input")).toHaveValue("First stored draft");
		paints = await pageB.evaluate(() => window.draftPaints ?? []);
		// A session this device has seen keeps its draft through the switch. The
		// first visit to an unseen one paints one empty frame until the
		// subscription's stored text arrives (recorded on conduit-test-9ra5.3).
		const firstPath = new URL(first).pathname;
		expect(
			paints.filter(({ path, text }) => path === firstPath && text === ""),
		).toEqual([]);
	} finally {
		await saveDraftEvidence(testInfo, [page, pageB], {
			A: callsA,
			B: callsB,
			paints,
			emptyComposerFrames: paints.filter((frame) => frame.text === ""),
		});
		await contextB.close();
	}
});
