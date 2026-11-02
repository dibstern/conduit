// Conduit acts only for its own origin (82tn.32.33.12), against a real daemon. A dev server
// behind the Preview Gate is same-site with conduit, so the browser sends conduit's
// SameSite=Strict cookie with its page's requests; with no PIN, any origin reaches the daemon.
// Failure cases, from the lane audit:
// V1 a foreign page opens the browser RPC WebSocket with the cookie;
// V2-V5 a foreign page or form posts to push subscribe/unsubscribe or to /auth;
// V6 a foreign preflight is answered, unlocking custom-header requests such as the PIN header;
// V7 a foreign page reads the project list, with or without a PIN;
// V10 an opaque (null) origin is treated as conduit's own.
// Callers that keep working: conduit's own page on localhost, over LAN and through Tailscale
// Serve; the CLI over its Unix socket; clients that send no Origin and authenticate another way.
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const ARTIFACT_DIR = "test/integration/daemon/artifacts";
const DNS = "origin-test.example.ts.net";

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}
const send = (
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: string,
): Promise<Reply> =>
	new Promise((done, fail) => {
		const req = request(
			{ host: "127.0.0.1", port, method, path, headers, agent: false },
			(res) => {
				let text = "";
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () =>
					done({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: text,
					}),
				);
			},
		);
		req.on("error", fail);
		req.end(body);
	});
/** 101 when the upgrade switched protocols; 0 when the daemon dropped the socket. */
const upgrade = (port: number, headers: Record<string, string>) =>
	new Promise<number>((done) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/rpc",
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
			socket.destroy();
			done(res.statusCode ?? 0);
		});
		req.on("response", (res) => {
			res.resume();
			done(res.statusCode ?? 0);
		});
		req.on("error", () => done(0));
		req.end();
	});

it("conduit refuses requests and WebSocket upgrades from other origins, and keeps its own page, the CLI and no-Origin clients working", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart();
	const port = Number(new URL(harness.baseUrl).port);
	const local = `localhost:${port}`;
	const own = { Host: local, Origin: `http://${local}` };
	// A gated dev server's page and a plain localhost dev app: same site, other origin.
	const gated = {
		Host: DNS,
		"X-Forwarded-Proto": "https",
		Origin: `https://${DNS}:5173`,
	};
	const devApp = { Host: local, Origin: "http://localhost:5173" };

	// V7 with no PIN: the daemon is open, so any origin could read it.
	const openRead = await send(port, "GET", "/api/projects", devApp);
	expect(openRead.status).toBe(403);
	expect(openRead.headers["access-control-allow-origin"]).toBeUndefined();
	expect((await send(port, "GET", "/api/projects", own)).status).toBe(200);

	// A4: the CLI's socket client is not HTTP and carries no origin.
	await sendRpcRequest(join(harness.configDir, "relay.sock"), {
		_tag: "SetPin",
		pin: "4321",
	});
	// A5: a no-Origin client signs in with the PIN.
	const signIn = await send(
		port,
		"POST",
		"/auth",
		{ "Content-Type": "application/json" },
		JSON.stringify({ pin: "4321" }),
	);
	expect(signIn.status).toBe(200);
	const cookie = /relay_session=[^;]+/.exec(
		String(signIn.headers["set-cookie"] ?? ""),
	)?.[0];
	expect(cookie).toBeDefined();
	const signedIn = { Cookie: cookie ?? "" };

	const foreign = [
		gated,
		devApp,
		{ Host: local, Origin: "null" }, // V10
		// Another Serve port in plain http on conduit's Tailscale name.
		{ Host: DNS, "X-Forwarded-Proto": "https", Origin: `http://${DNS}` },
	];
	const refused: Record<string, number[]> = {};
	const refuse = async (
		name: string,
		reply: Promise<Reply> | Promise<number>,
	) => {
		const result = await reply;
		const status = typeof result === "number" ? result : result.status;
		(refused[name] ??= []).push(status);
		return status;
	};
	for (const origin of foreign) {
		const headers = { ...origin, ...signedIn };
		// V1
		expect(await refuse("ws", upgrade(port, headers))).toBe(0);
		// V2, V5: a form-style text/plain post needs no preflight.
		expect(
			await refuse(
				"push-subscribe",
				send(
					port,
					"POST",
					"/api/push/subscribe",
					{ ...headers, "Content-Type": "text/plain" },
					JSON.stringify({
						subscription: {
							endpoint: "https://attacker.example/push",
							keys: { p256dh: "x", auth: "y" },
						},
					}),
				),
			),
		).toBe(403);
		// V3
		expect(
			await refuse(
				"push-unsubscribe",
				send(
					port,
					"POST",
					"/api/push/unsubscribe",
					{ ...headers, "Content-Type": "text/plain" },
					JSON.stringify({ endpoint: "https://push.example/user" }),
				),
			),
		).toBe(403);
		// V4: a PIN guess would spend the user's own attempt budget.
		expect(
			await refuse(
				"auth",
				send(
					port,
					"POST",
					"/auth",
					{ ...headers, "Content-Type": "text/plain" },
					JSON.stringify({ pin: "0000" }),
				),
			),
		).toBe(403);
		// V6
		const preflight = await send(port, "OPTIONS", "/api/projects", {
			...origin,
			"Access-Control-Request-Method": "GET",
			"Access-Control-Request-Headers": "x-relay-pin",
		});
		await refuse("preflight", Promise.resolve(preflight));
		expect(preflight.status).toBe(403);
		expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
		// V7 with the cookie.
		const read = await send(port, "GET", "/api/projects", headers);
		await refuse("read", Promise.resolve(read));
		expect(read.status).toBe(403);
		expect(read.headers["access-control-allow-origin"]).toBeUndefined();
	}
	// The refused PIN guesses spent nothing.
	const guess = await send(
		port,
		"POST",
		"/auth",
		{
			...own,
			"Content-Type": "application/json",
		},
		JSON.stringify({ pin: "0000" }),
	);
	expect(JSON.parse(guess.body)).toMatchObject({ attemptsLeft: 4 });

	// A1-A3, A5: conduit's own page on localhost, over LAN and through Tailscale Serve, and a
	// client with no Origin.
	const allowed = [
		own,
		{ Host: `192.168.1.20:${port}`, Origin: `http://192.168.1.20:${port}` },
		{ Host: DNS, "X-Forwarded-Proto": "https", Origin: `https://${DNS}` },
		{ Host: local },
	];
	const accepted: { ws: number; read: number; unsubscribe: number }[] = [];
	for (const origin of allowed) {
		const headers = { ...origin, ...signedIn };
		const ws = await upgrade(port, headers);
		const read = await send(port, "GET", "/api/projects", headers);
		const unsubscribe = await send(
			port,
			"POST",
			"/api/push/unsubscribe",
			{ ...headers, "Content-Type": "application/json" },
			JSON.stringify({ endpoint: "https://push.example/user" }),
		);
		accepted.push({ ws, read: read.status, unsubscribe: unsubscribe.status });
		expect(ws).toBe(101);
		expect(read.status).toBe(200);
		expect(unsubscribe.status).not.toBe(403);
	}
	// A5: the PIN header alone, no cookie and no Origin.
	expect(await upgrade(port, { Host: local, "x-relay-pin": "4321" })).toBe(101);

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		join(ARTIFACT_DIR, "origin-check.json"),
		JSON.stringify({ foreign, refused, allowed, accepted }, null, 2),
	);
});
