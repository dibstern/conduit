// A phone opens a session's dev server through the Preview Gate (CONTRACT.md 8.7), automated in
// place of a manual phone run (82tn.32.33.9 box 7). Real Tailscale, TLS trust and a phone's own
// browser stay out of scope by that decision.
//
// The phone reaches conduit the way `tailscale serve` delivers it: a TLS front reads the Serve
// config the fake tailscale keeps, keeps Host, and names the scheme in X-Forwarded-Proto, which is
// what isOwnOrigin (src/lib/server/http-utils.ts) and the gate (preview-gate-layer.ts) see from a
// remote device. The browser resolves the tailnet name only through a CONNECT proxy to that front,
// so no request it makes carries a loopback Host or Origin.
//
// Failure cases:
// F1 the gate never serves the session's server, or Open and the chat chip keep the localhost link;
// F2 the page loads on the phone but not through the gate (another handler, or a loopback Host);
// F3 the page loads but its WebSocket back to itself does not round-trip through the gate;
// F4 conduit's login cookie reaches the dev server;
// F5 a request or WebSocket without conduit's login reaches the dev server.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	request,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import {
	connect,
	createServer as createTcpServer,
	type Server,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Result as Either } from "effect";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeTestTlsCerts } from "../../helpers/tls-cert-fixture.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const DNS = "phone-gate.tail0000.ts.net";
const PHONE_IP = "100.64.0.7";
const PIN = "4826";
const SESSION = "phone-gate";
const ARTIFACTS = resolve("test-results/preview-gate-mobile");
// Serve status and edits as tailscale applies them; any other command fails the run.
const FAKE_TAILSCALE = `const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.jsonl"), JSON.stringify(args) + "\\n");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
if (args.join(" ") === "status --json") process.stdout.write(read("status.json"));
else if (args.join(" ") === "serve status --json") process.stdout.write(read("serve.json"));
else {
  const config = JSON.parse(read("serve.json"));
  const https = args.find((arg) => arg.startsWith("--https="));
  const server = ((config.Web ??= {})["${DNS}:" + https.slice(8)] ??= { Handlers: {} });
  if (args.length === 5 && args.slice(0, 4).join(" ") === "serve --bg " + https + " --set-path=/") server.Handlers["/"] = { Proxy: args[4] };
  else if (args.join(" ") === "serve " + https + " --set-path=/ off") delete server.Handlers["/"];
  else { process.stderr.write("unexpected " + JSON.stringify(args)); process.exit(2); }
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(config));
}
`;
// The dev server: a page that says what reached the server and opens a WebSocket back to itself.
const APP = `const http = require("node:http");
const { WebSocketServer } = require(process.env.WS_MODULE);
const server = http.createServer((req, res) => {
	const upstream = JSON.stringify({ host: req.headers.host, url: req.url, conduitCookie: /relay_session=/.test(req.headers.cookie ?? "") }).replace(/</g, "\\\\u003c");
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(\`<!doctype html><meta name="viewport" content="width=device-width"><title>Phone app</title>
<h1>Phone app</h1><pre id="upstream">\${upstream}</pre><p id="ws">connecting</p>
<script>
const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/socket");
socket.onopen = () => socket.send("ping " + location.pathname);
socket.onmessage = (event) => { document.getElementById("ws").textContent = event.data; };
socket.onerror = () => { document.getElementById("ws").textContent = "error"; };
</script>\`);
});
new WebSocketServer({ server }).on("connection", (socket) => socket.on("message", (data) => socket.send("echo " + data)));
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
`;

const listen = async <T extends Server>(server: T) => {
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	return typeof address === "object" && address !== null ? address.port : 0;
};

/** One user prompt and the agent's reply naming the dev server by its localhost link. */
const seed = (filename: string, port: number) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const now = Date.now();
			const message = (
				id: string,
				role: "user" | "assistant",
				text: string,
				at: number,
			) =>
				canonicalEvent(
					"message.snapshot",
					SESSION,
					{
						messageId: id,
						digest: id,
						message: {
							id,
							sessionID: SESSION,
							role,
							...(role === "assistant" ? { parentID: "prompt" } : {}),
							time: {
								created: at,
								...(role === "assistant" ? { completed: at + 1000 } : {}),
							},
							parts: [{ id: `${id}-text`, type: "text", text }],
						},
					},
					{ provider: "claude", createdAt: at },
				);
			yield* commit(
				[
					canonicalEvent(
						"session.created",
						SESSION,
						{
							sessionId: SESSION,
							title: "Phone gate",
							provider: "claude",
							providerSessionId: SESSION,
						},
						{ provider: "claude", createdAt: now },
					),
					message("prompt", "user", "Start the dev server.", now + 1000),
					message(
						"reply",
						"assistant",
						`The app is up at <http://localhost:${port}/from-chat>.`,
						now + 2000,
					),
				],
				{ publish: false },
			);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

// Warnings name a Tailscale or gate failure in daemon.log.
test.use({ harnessOptions: { logLevel: "warn" } });

test("a phone opens a session's dev server through the Preview Gate from the Servers pane and a chat chip", async ({
	harness,
	browser,
}, testInfo) => {
	// Outside the repo, whose package.json would make the extensionless fake an ES module.
	const root = mkdtempSync(join(tmpdir(), "conduit-phone-gate-"));
	const tailscale = join(root, "tailscale");
	writeFileSync(tailscale, `#!${process.execPath}\n${FAKE_TAILSCALE}`);
	chmodSync(tailscale, 0o755);
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			BackendState: "Running",
			Self: { DNSName: `${DNS}.` },
			CertDomains: [DNS],
		}),
	);
	writeFileSync(join(root, "serve.json"), "{}");
	const proxyOf = (port: number): string | undefined =>
		JSON.parse(readFileSync(join(root, "serve.json"), "utf8")).Web?.[
			`${DNS}:${port}`
		]?.Handlers?.["/"]?.Proxy;

	// tailscaled's side: TLS on the tailnet name, routed by the Serve config's '/' handler for the
	// port the phone asked for. `seen` is every request the phone sent, as the tailnet saw it.
	type Seen = {
		host: string;
		url: string;
		proxy?: string;
		status?: number | undefined;
	};
	const seen: Seen[] = [];
	const handlerOf = (req: IncomingMessage) => {
		const port = Number(new URL(`https://${req.headers.host}`).port || 443);
		const proxy = proxyOf(port);
		return proxy === undefined ? undefined : new URL(proxy);
	};
	const forwarded = {
		"x-forwarded-proto": "https",
		"x-forwarded-for": PHONE_IP,
	};
	const tailnet = createHttpsServer(makeTestTlsCerts(), (req, res) => {
		const to = handlerOf(req);
		const entry: Seen = {
			host: req.headers.host ?? "",
			url: req.url ?? "",
			...(to && { proxy: to.origin }),
		};
		seen.push(entry);
		if (to === undefined) {
			res.writeHead(404).end();
			return;
		}
		const upstream = request(
			{
				host: to.hostname,
				port: to.port,
				method: req.method,
				path: req.url,
				headers: { ...req.headers, ...forwarded },
				agent: false,
			},
			(answer) => {
				entry.status = answer.statusCode;
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	tailnet.on("upgrade", (req: IncomingMessage, socket, head) => {
		const to = handlerOf(req);
		seen.push({
			host: req.headers.host ?? "",
			url: `upgrade ${req.url}`,
			...(to && { proxy: to.origin }),
		});
		if (to === undefined) {
			socket.destroy();
			return;
		}
		const upstream = connect(Number(to.port), to.hostname, () => {
			const lines = Object.entries({ ...req.headers, ...forwarded }).flatMap(
				([name, value]) => [value].flat().map((one) => `${name}: ${one}\r\n`),
			);
			upstream.write(
				`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("")}\r\n`,
			);
			upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	// The phone's only route: the tailnet name, nothing else.
	const tunnels: string[] = [];
	const phoneRoute = createHttpServer((_, res) => res.writeHead(405).end());
	const tailnetPort = await listen(tailnet);
	phoneRoute.on("connect", (req, socket, head) => {
		tunnels.push(req.url ?? "");
		if (new URL(`https://${req.url}`).hostname !== DNS) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const upstream = connect(tailnetPort, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	const phoneRoutePort = await listen(phoneRoute);

	const probe = createTcpServer();
	const appPort = await listen(probe);
	await new Promise((done) => probe.close(done));
	const appFile = testInfo.outputPath("phone-app.cjs");
	writeFileSync(appFile, APP);
	let app: ChildProcess | undefined;
	try {
		await harness.terminate();
		await seed(harness.daemonStorePath(), appPort);
		// The user's one consent to conduit editing its Serve config.
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			JSON.stringify({
				...Either.getOrThrow(loadDaemonConfigResult(harness.configDir)),
				tailscaleServe: true,
			}),
		);
		await harness.restart({
			keepPort: true,
			serviceEnvironment: {
				CONDUIT_PORT_WATCH_INTERVAL_MS: "200",
				CONDUIT_PORT_WATCH_HOLD_MS: "600",
				CONDUIT_TAILSCALE_BIN: tailscale,
			},
		});
		await harness.requestRpc({ _tag: "SetPin", pin: PIN });
		const conduitPort = Number(new URL(harness.baseUrl).port);
		await expect.poll(() => proxyOf(conduitPort)).toBe(harness.baseUrl);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			APP: appFile,
			PORT: String(appPort),
			WS_MODULE: createRequire(import.meta.url).resolve("ws"),
			CONDUIT_SESSION_ID: SESSION,
		};
		delete env["CODEX_THREAD_ID"];
		delete env["CONDUIT_OPENCODE_SESSION_ID"];
		delete env["CONDUIT_OPENCODE_INSTANCE_ID"];
		app = spawn("/bin/sh", ["-c", 'node "$APP" & wait $!'], {
			env,
			stdio: ["ignore", "pipe", "inherit"],
			detached: true,
		});
		const [line] = (await once(
			createInterface({ input: app.stdout ?? process.stdin }),
			"line",
		)) as [string];
		const server = JSON.parse(line) as { pid: number; port: number };
		// F1: the gate serves the session's server.
		await expect
			.poll(() => proxyOf(appPort))
			.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		const gateUrl = `https://${DNS}:${appPort}`;

		const {
			viewport = null,
			isMobile = false,
			hasTouch = false,
		} = testInfo.project.use;
		const phone = {
			viewport,
			isMobile,
			hasTouch,
			ignoreHTTPSErrors: true,
			proxy: { server: `http://127.0.0.1:${phoneRoutePort}` },
		};
		const context = await browser.newContext(phone);
		const stranger = await browser.newContext(phone);
		try {
			const page = await context.newPage();
			const conduitUrl = `https://${DNS}:${conduitPort}`;
			await page.goto(conduitUrl);
			const pin = page.getByPlaceholder("PIN (4-8 digits)", { exact: true });
			await pin.fill(PIN);
			await pin.press("Enter");
			const userAgent = await page.evaluate(() => navigator.userAgent);

			/** Opens `link` in a new tab and reads what loaded there. */
			const openFrom = async (from: string, link: () => Promise<void>) => {
				const [tab, response] = await Promise.all([
					context.waitForEvent("page"),
					context.waitForEvent("response", {
						predicate: (answer) =>
							answer.request().isNavigationRequest() &&
							answer.url().startsWith(gateUrl),
					}),
					link(),
				]);
				await expect(tab.locator("#ws")).toHaveText(/^echo ping /);
				const result = {
					from,
					url: tab.url(),
					status: response.status(),
					upstream: JSON.parse(
						(await tab.locator("#upstream").textContent()) ?? "{}",
					) as Record<string, unknown>,
					websocket: await tab.locator("#ws").textContent(),
					screenshot: join(ARTIFACTS, `${from}.png`),
				};
				mkdirSync(ARTIFACTS, { recursive: true });
				await tab.screenshot({ path: result.screenshot });
				await tab.close();
				return result;
			};

			// From the Servers pane's Open, reached from the session row's servers button.
			await page
				.getByRole("button", { name: "1 server running. Open Servers" })
				.click();
			const open = page.getByRole("link", {
				name: `Open phone-app.cjs at ${gateUrl}`,
			});
			await expect(open).toBeVisible();
			await page.screenshot({ path: join(ARTIFACTS, "servers-pane.png") });
			const fromPane = await openFrom("servers-pane-open", () => open.click());

			// From the chat chip the agent's localhost link became.
			await page.getByTestId("session-bar-island-overflow").click();
			await page.getByTestId("overflow-view-chat").click();
			const chip = page.locator(
				`#messages a[data-server-chip="live"][href="${gateUrl}/from-chat"]`,
			);
			await expect(chip).toBeVisible();
			const fromChip = await openFrom("chat-chip", () => chip.click());

			// F2, F3, F4: served through the gate to the dev server's own localhost Host, the
			// WebSocket echoed, and conduit's cookie stopped at the gate.
			for (const [result, path] of [
				[fromPane, "/"],
				[fromChip, "/from-chat"],
			] as const)
				expect(result).toMatchObject({
					url: `${gateUrl}${path}`,
					status: 200,
					upstream: {
						host: `localhost:${appPort}`,
						url: path,
						conduitCookie: false,
					},
					websocket: `echo ping ${path}`,
				});

			// F5: a device without conduit's login gets the sign-in page, and its WebSocket is refused.
			const outsider = await stranger.newPage();
			const refused = await outsider.goto(`${gateUrl}/`);
			await expect(outsider.locator("h1")).toHaveText("Sign in to conduit");
			const refusedSocket = await outsider.evaluate(
				(url) =>
					new Promise<string>((done) => {
						const socket = new WebSocket(url);
						socket.onopen = () => done("open");
						socket.onclose = () => done("closed");
					}),
				`wss://${DNS}:${appPort}/socket`,
			);
			await outsider.screenshot({ path: join(ARTIFACTS, "refused.png") });
			expect({ status: refused?.status(), refusedSocket }).toEqual({
				status: 401,
				refusedSocket: "closed",
			});
			// Every tunnel the phone opened named the tailnet, and every request it sent to the
			// dev server's port went to the gate's proxy.
			expect(tunnels.every((target) => target.startsWith(`${DNS}:`))).toBe(
				true,
			);
			expect(
				seen
					.filter(({ host }) => host === `${DNS}:${appPort}`)
					.every(({ proxy }) => proxy === proxyOf(appPort)),
			).toBe(true);

			writeFileSync(
				join(ARTIFACTS, "result.json"),
				JSON.stringify(
					{
						viewport,
						isMobile,
						hasTouch,
						userAgent,
						conduitUrl,
						gateUrl,
						gateProxy: proxyOf(appPort),
						server,
						opened: [fromPane, fromChip],
						refused: { status: refused?.status(), websocket: refusedSocket },
						tunnels: [...new Set(tunnels)],
						requests: seen,
						tailscale: readFileSync(join(root, "argv.jsonl"), "utf8")
							.trim()
							.split("\n")
							.map((args) => JSON.parse(args)),
					},
					null,
					2,
				),
			);
		} finally {
			await context.close();
			await stranger.close();
		}
	} finally {
		writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
		if (app?.pid !== undefined && app.exitCode === null)
			process.kill(-app.pid, "SIGKILL");
		tailnet.closeAllConnections();
		tailnet.close();
		phoneRoute.closeAllConnections();
		phoneRoute.close();
		rmSync(root, { recursive: true, force: true });
	}
});
