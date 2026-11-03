// Preview Gate (CONTRACT.md 8.7) against a real daemon, real node servers and a fake tailscale.
// Failure cases, from the leak and abuse list:
// L1 a port rebound by another process before the next scan is proxied to that process;
// L2 a port that is not in Servers gets a Serve handler, or a server that left keeps its handler;
// L3 a request with no cookie, a forged cookie or only the PIN header reaches the server;
// L4 Host, X-Forwarded-Host or an absolute-form target moves the target, conduit's cookie or PIN
//    reaches the server, or the server's Set-Cookie replaces conduit's session cookie;
// L5 an unauthenticated websocket upgrade is piped, or an authenticated one is not;
// L6 the gate issues a redirect, or a server's redirect to its own localhost leaves the gate;
// L7 a crashed daemon's recorded handler survives a restart, or one the user replaced is removed;
// L8 a foreign '/' handler on a server's port is replaced.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	watch,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Result as Either } from "effect";
import { afterEach, expect, it } from "vitest";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const DNS = "gate-test.example.ts.net";
const LINGER_MS = 1500;
const ARTIFACT_DIR = "test/integration/daemon/artifacts";
// Serve status and edits as tailscale applies them; any other command fails the run.
const FAKE_TAILSCALE = `#!/usr/bin/env node
const fs = require("node:fs");
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
  const key = "${DNS}:" + https.slice("--https=".length);
  const server = ((config.Web ??= {})[key] ??= { Handlers: {} });
  if (args.length === 5 && args.slice(0, 4).join(" ") === "serve --bg " + https + " --set-path=/") server.Handlers["/"] = { Proxy: args[4] };
  else if (args.join(" ") === "serve " + https + " --set-path=/ off") delete server.Handlers["/"];
  else { process.stderr.write("unexpected " + JSON.stringify(args)); process.exit(2); }
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(config));
}
`;
// Echoes what reached it; /redirect and /cookie answer as a dev server might.
const ECHO = `const http = require("node:http");
const server = http.createServer((req, res) => {
	if (req.url === "/redirect") { res.writeHead(302, { Location: "http://localhost:" + server.address().port + "/landed?x=1" }); return res.end(); }
	if (req.url === "/cookie") res.setHeader("Set-Cookie", ["relay_session=evil; Path=/", "theme=dark; Path=/"]);
	res.end(JSON.stringify({ by: process.env.NAME, url: req.url, headers: req.headers }));
});
server.on("upgrade", (req, socket) => {
	socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
	socket.pipe(socket);
});
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () =>
	console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));`;

let harness: ProcessHarness | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0))
		if (child.pid !== undefined && child.exitCode === null)
			process.kill(-child.pid, "SIGKILL");
	await harness?.dispose();
	harness = undefined;
});

/** A node server, inside the session when `sessionId` is given; resolves once it listens. */
const startServer = async (
	name: string,
	sessionId: string | undefined,
	port = 0,
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ECHO,
		NAME: name,
		PORT: String(port),
	};
	delete env["CONDUIT_SESSION_ID"];
	delete env["CODEX_THREAD_ID"];
	delete env["CONDUIT_OPENCODE_SESSION_ID"];
	if (sessionId !== undefined) env["CONDUIT_SESSION_ID"] = sessionId;
	const child = spawn("/bin/sh", ["-c", 'node -e "$ECHO" & wait $!'], {
		env,
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	children.push(child);
	const [line] = (await once(
		createInterface({ input: child.stdout ?? process.stdin }),
		"line",
	)) as [string];
	return JSON.parse(line) as { pid: number; port: number };
};

const freePort = async () => {
	const probe = createServer();
	await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
	const address = probe.address();
	await new Promise((done) => probe.close(done));
	return typeof address === "object" && address !== null ? address.port : 0;
};

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}
const send = (
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<Reply> =>
	new Promise((done, fail) => {
		const req = request(
			{ host: "127.0.0.1", port, path, headers, agent: false },
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () =>
					done({ status: res.statusCode ?? 0, headers: res.headers, body }),
				);
			},
		);
		req.on("error", fail);
		req.end();
	});
/** An upgrade's status, and the echo of "ping" when it switched protocols. */
const upgrade = (port: number, headers: Record<string, string> = {}) =>
	new Promise<{ status: number; echo?: string }>((done, fail) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/socket",
			agent: false,
			headers: {
				...headers,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
			},
		});
		req.on("upgrade", (res, socket) => {
			socket.once("data", (chunk) => {
				socket.destroy();
				done({ status: res.statusCode ?? 0, echo: String(chunk) });
			});
			socket.write("ping");
		});
		req.on("response", (res) => {
			res.resume();
			done({ status: res.statusCode ?? 0 });
		});
		req.on("error", fail);
		req.end();
	});

it("the Preview Gate serves only Servers ports, behind conduit's login, to the listener it saw, and removes only its own handlers", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-preview-gate-"));
	const tailscale = join(root, "tailscale");
	writeFileSync(tailscale, FAKE_TAILSCALE);
	chmodSync(tailscale, 0o755);
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			BackendState: "Running",
			Self: { DNSName: `${DNS}.` },
			CertDomains: [DNS],
		}),
	);
	const foreignPort = await freePort();
	// L7: a crashed daemon's handler (recorded, unchanged) and one the user has since replaced.
	writeFileSync(
		join(root, "serve.json"),
		JSON.stringify({
			Web: {
				[`${DNS}:4999`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } },
				[`${DNS}:4998`]: {
					Handlers: { "/": { Proxy: "http://127.0.0.1:7777" } },
				},
				[`${DNS}:${foreignPort}`]: {
					Handlers: { "/": { Proxy: "http://127.0.0.1:9" } },
				},
			},
		}),
	);
	const serve = (): Record<
		string,
		{ Handlers: Record<string, { Proxy?: string }> }
	> => JSON.parse(readFileSync(join(root, "serve.json"), "utf8")).Web ?? {};
	const proxyOf = (port: number) =>
		serve()[`${DNS}:${port}`]?.Handlers["/"]?.Proxy;
	const invocations = (): string[][] =>
		readFileSync(join(root, "argv.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	// Resolves once the Serve config satisfies `ready`, re-read on each write by the fake. A read
	// that lands mid-write is not ready; the write's end is another event.
	const serveSettles = (ready: () => boolean) =>
		new Promise<void>((done) => {
			const settled = () => {
				try {
					return ready();
				} catch {
					return false;
				}
			};
			if (settled()) return done();
			const watcher = watch(root, () => {
				if (settled()) {
					watcher.close();
					done();
				}
			});
		});

	harness = ProcessHarness.create({ logLevel: "warn" });
	const configDir = harness.configDir;
	writeFileSync(
		join(configDir, "preview-gate.json"),
		JSON.stringify([
			{ port: 4999, proxy: "http://127.0.0.1:1" },
			{ port: 4998, proxy: "http://127.0.0.1:2" },
		]),
	);
	// The user's one consent to conduit editing its Serve config.
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({
			...Either.getOrThrow(loadDaemonConfigResult(configDir)),
			tailscaleServe: true,
		}),
	);
	await harness.restart({
		serviceEnvironment: {
			CONDUIT_PORT_WATCH_INTERVAL_MS: "200",
			CONDUIT_PORT_WATCH_HOLD_MS: "600",
			CONDUIT_TAILSCALE_BIN: tailscale,
			CONDUIT_PREVIEW_GATE_LINGER_MS: String(LINGER_MS),
		},
	});
	await serveSettles(() => proxyOf(4999) === undefined);
	expect(proxyOf(4998)).toBe("http://127.0.0.1:7777");

	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Gate");
	const listedPorts = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? ((frame["servers"] ?? []) as readonly { port: number }[]).map(
					(server) => server.port,
				)
			: undefined;

	// L8: the session's server on a port whose '/' is someone else's is listed but not gated.
	await startServer("foreign", sessionId, foreignPort);
	await browser.waitFor(
		(frame) => listedPorts(frame)?.includes(foreignPort) ?? false,
	);
	const outside = await startServer("outside", undefined);
	const app = await startServer("app", sessionId);
	const doomed = await startServer("doomed", sessionId);
	await serveSettles(
		() => proxyOf(app.port) !== undefined && proxyOf(doomed.port) !== undefined,
	);
	const gateOf = (port: number) =>
		Number(/:(\d+)$/.exec(proxyOf(port) ?? "")?.[1]);
	const gate = gateOf(app.port);
	const doomedGate = gateOf(doomed.port);
	expect(proxyOf(foreignPort)).toBe("http://127.0.0.1:9");
	// L2: a port outside any session never gets a handler.
	expect(proxyOf(outside.port)).toBeUndefined();
	expect(
		invocations().filter((args) =>
			args.some(
				(arg) =>
					arg === `--https=${foreignPort}` ||
					arg === `--https=${outside.port}` ||
					arg === "--https=4998",
			),
		),
	).toEqual([]);
	// The pane's Open: the session row names the gate's link for each port the gate serves, and
	// none for the port whose '/' is someone else's.
	const gateUrls = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? Object.fromEntries(
					(
						(frame["servers"] ?? []) as readonly {
							port: number;
							gateUrl?: string;
						}[]
					).map(({ port, gateUrl }) => [port, gateUrl]),
				)
			: undefined;
	const linked = await browser.waitFor((frame) => {
		const urls = gateUrls(frame);
		return urls?.[app.port] !== undefined && urls[doomed.port] !== undefined;
	});
	expect(gateUrls(linked)).toEqual({
		[foreignPort]: undefined,
		[app.port]: `https://${DNS}:${app.port}`,
		[doomed.port]: `https://${DNS}:${doomed.port}`,
	});

	// L1: the server dies and another process takes its port before the next scan (no PIN yet,
	// so the daemon and the gate are open).
	const cursor = browser.frames.length;
	process.kill(doomed.pid, "SIGKILL");
	const intruder = await startServer("intruder", undefined, doomed.port);
	const stopped = await send(doomedGate, "/");
	expect(stopped.status).toBe(503);
	expect(stopped.body).toContain("Server stopped");
	expect(await upgrade(doomedGate)).toEqual({ status: 503 });
	await browser.waitFor(
		(frame) => listedPorts(frame)?.includes(doomed.port) === false,
		cursor,
	);
	// Gone from Servers: still the stopped page while it lingers, then the handler goes (L2).
	expect((await send(doomedGate, "/")).status).toBe(503);
	await serveSettles(() => proxyOf(doomed.port) === undefined);
	await expect(send(doomedGate, "/")).rejects.toThrow(/ECONNREFUSED/);

	await sendRpcRequest(join(configDir, "relay.sock"), {
		_tag: "SetPin",
		pin: "4321",
	});
	const signIn = await fetch(`${harness.baseUrl}/auth`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pin: "4321" }),
	});
	const cookie = /relay_session=[^;]+/.exec(
		signIn.headers.get("set-cookie") ?? "",
	)?.[0];
	expect(cookie).toBeDefined();
	const signedIn = { Cookie: `${cookie}; theme=light` };

	// L3: refused without the login, with no Location (L6).
	const refused = await Promise.all([
		send(gate, "/"),
		send(gate, "/", { Cookie: "relay_session=9999999999999.forged" }),
		send(gate, "/", { "x-relay-pin": "4321" }),
	]);
	expect(refused.map(({ status }) => status)).toEqual([401, 401, 401]);
	expect(refused.map(({ headers }) => headers["location"])).toEqual([
		undefined,
		undefined,
		undefined,
	]);
	expect(refused.some(({ body }) => body.includes('"by"'))).toBe(false);

	// L4: the listener fixes the target; conduit's cookie and PIN stop at the gate.
	const proxied = await send(gate, "/page?q=1", {
		...signedIn,
		Host: "evil.example:1",
		"X-Forwarded-Host": `127.0.0.1:${outside.port}`,
		"x-relay-pin": "4321",
	});
	expect(proxied.status).toBe(200);
	const echoed = JSON.parse(proxied.body);
	expect(echoed).toMatchObject({ by: "app", url: "/page?q=1" });
	expect(echoed.headers.cookie).toBe("theme=light");
	expect(echoed.headers["x-relay-pin"]).toBeUndefined();
	expect(
		(await send(gate, `http://127.0.0.1:${outside.port}/`, signedIn)).status,
	).toBe(400);
	const cookies = await send(gate, "/cookie", signedIn);
	expect(cookies.headers["set-cookie"]).toEqual(["theme=dark; Path=/"]);
	// L6: the server's redirect to its own localhost stays on the gate's origin.
	expect((await send(gate, "/redirect", signedIn)).headers["location"]).toBe(
		"/landed?x=1",
	);

	// L5
	expect(await upgrade(gate)).toEqual({ status: 401 });
	expect(await upgrade(gate, signedIn)).toEqual({ status: 101, echo: "ping" });

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		join(ARTIFACT_DIR, "preview-gate.json"),
		JSON.stringify(
			{
				app,
				doomed,
				intruder,
				outside,
				foreignPort,
				gate,
				refused: refused.map(({ status }) => status),
				proxied: echoed,
				stopped: stopped.status,
				tailscale: invocations(),
				serve: serve(),
			},
			null,
			2,
		),
	);
});
