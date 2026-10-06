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
	test as base,
	expect,
	type Page,
	type TestInfo,
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

function captureBuildHandshakes(page: Page): string[] {
	const handshakes: string[] = [];
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/ws") return;
		socket.on("framereceived", ({ payload }) => {
			const message = JSON.parse(String(payload)) as {
				type: string;
				buildId?: string;
			};
			if (message.type === "protocol_version" && message.buildId)
				handshakes.push(message.buildId);
		});
	});
	return handshakes;
}

async function readServerBuildId(baseUrl: string): Promise<string> {
	const socket = new WebSocket(
		`${baseUrl.replace("http:", "ws:")}/ws?p=build-id-test`,
	);
	try {
		return await new Promise<string>((resolve, reject) => {
			// Other relay bootstrap messages can precede the handshake.
			socket.on("message", (data) => {
				const message = JSON.parse(String(data)) as {
					type: string;
					buildId: string;
				};
				if (message.type === "protocol_version") resolve(message.buildId);
			});
			socket.once("error", reject);
			socket.once("close", () => reject(new Error("No build handshake")));
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
	};
}>({
	buildDaemon: async ({ browserName: _browserName }, use) => {
		const root = mkdtempSync(join(tmpdir(), "conduit-build-id-"));
		const staticDir = join(root, "frontend");
		mkdirSync(join(root, "build-id-test"));
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
			if (!child || child.exitCode !== null) return;
			const exited = once(child, "exit");
			child.send("stop");
			await exited;
		};
		const start = async (port = 0, buildId?: string) => {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: join(root, "xdg"),
				CLAUDE_CONFIG_DIR: join(root, "claude"),
				CONDUIT_CONFIG_DIR: join(root, "config"),
			};
			// Never inherit a caller's override for the normal matching case.
			delete env["CONDUIT_SERVER_BUILD_ID"];
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
	const handshakes = captureBuildHandshakes(page);
	await page.goto(`${buildDaemon.baseUrl}/?p=build-id-test`);
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/s\//);
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
		page.getByText("Conduit was updated. Saving your draft and reloading…"),
	).toBeVisible();
	await page.waitForFunction(
		() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"),
		undefined,
		{ polling: 10 },
	);
	// The reload notice lasts 750ms after SW activation. Edit near its end so
	// the 300ms debounce cannot save this final text before the automatic reload.
	await page.waitForTimeout(500);
	await input.fill(draft);
	await expect.poll(() => reloads).toBe(1);
	await expect(input).toHaveValue(draft);
	await expect(
		page.locator(".banner-text", { hasText: "different builds" }),
	).toBeVisible();
	await expect
		.poll(() => handshakes.filter((id) => id === buildB).length)
		.toBe(2);
	await expect
		.poll(() => page.evaluate(() => caches.keys()))
		.not.toContain("conduit-legacy-shell");
	expect(await page.content()).not.toContain("<!-- stale shell -->");
	await page.waitForTimeout(1_500);
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
	await page.waitForTimeout(1_500);
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
