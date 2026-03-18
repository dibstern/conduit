import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RecordingProxy } from "../../helpers/recording-proxy.js";

// Fake "OpenCode" server
function createFakeUpstream(): {
	server: Server;
	wss: WebSocketServer;
	openResponses: Set<ServerResponse>;
} {
	const openResponses = new Set<ServerResponse>();

	const server = createServer((req, res) => {
		if (req.url === "/path") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ cwd: "/tmp/test" }));
		} else if (req.url === "/session") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify([{ id: "ses_1", title: "Test" }]));
		} else if (req.url === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			openResponses.add(res);
			res.on("close", () => openResponses.delete(res));
			setTimeout(() => {
				if (!res.writableEnded) {
					res.write('data: {"type":"server.connected","properties":{}}\n\n');
				}
			}, 10);
			setTimeout(() => {
				if (!res.writableEnded) {
					res.write(
						'data: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"idle"}}}\n\n',
					);
				}
			}, 20);
		} else {
			res.writeHead(404);
			res.end();
		}
	});

	// WebSocket for PTY
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		if (req.url?.startsWith("/pty/")) {
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
				// Echo back text, send a binary cursor metadata frame
				ws.on("message", (data, isBinary) => {
					if (!isBinary) {
						ws.send(`echo: ${data.toString()}`);
					}
				});
				// Send cursor metadata (0x00 prefix)
				const cursor = Buffer.from([0x00, ...Buffer.from('{"cursor":1}')]);
				ws.send(cursor);
				// Send text output
				ws.send("$ hello world\r\n");
			});
		}
	});

	return { server, wss, openResponses };
}

describe("RecordingProxy", () => {
	let upstream: ReturnType<typeof createFakeUpstream>;
	let upstreamPort: number;
	let proxy: RecordingProxy;

	beforeAll(async () => {
		upstream = createFakeUpstream();
		await new Promise<void>((r) => upstream.server.listen(0, "127.0.0.1", r));
		upstreamPort = (upstream.server.address() as { port: number }).port;
		proxy = new RecordingProxy(`http://127.0.0.1:${upstreamPort}`);
		await proxy.start();
	});

	afterAll(async () => {
		await proxy.stop();
		// End any lingering SSE responses so the server can close
		for (const res of upstream.openResponses) {
			res.end();
		}
		upstream.wss.close();
		await new Promise<void>((r) => upstream.server.close(() => r()));
	});

	it("proxies REST requests and records interactions", async () => {
		const res = await fetch(`${proxy.url}/path`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ cwd: "/tmp/test" });

		const recording = proxy.getRecording();
		const restEntries = recording.filter((i) => i.kind === "rest");
		expect(restEntries.length).toBeGreaterThanOrEqual(1);
		expect(restEntries[0]).toMatchObject({
			kind: "rest",
			method: "GET",
			path: "/path",
			status: 200,
		});
	});

	it("captures SSE events", async () => {
		const controller = new AbortController();
		const res = await fetch(`${proxy.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();

		const recording = proxy.getRecording();
		const sseEntries = recording.filter((i) => i.kind === "sse");
		expect(sseEntries.length).toBeGreaterThanOrEqual(1);
		expect(sseEntries[0]).toMatchObject({
			kind: "sse",
			type: "server.connected",
		});
	});

	it("proxies PTY WebSocket and records frames", async () => {
		// Use ws library to connect through the proxy
		const { WebSocket } = await import("ws");
		const proxyUrl = proxy.url.replace("http://", "ws://");
		const ws = new WebSocket(`${proxyUrl}/pty/test-pty/connect?cursor=0`);

		const received: string[] = [];
		await new Promise<void>((resolve, reject) => {
			ws.on("open", () => {
				ws.send("ls -la");
			});
			ws.on("message", (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});
			// Give time for messages to flow
			setTimeout(() => {
				ws.close();
				resolve();
			}, 200);
			ws.on("error", reject);
		});

		expect(received).toContain("$ hello world\r\n");
		expect(received).toContain("echo: ls -la");

		const recording = proxy.getRecording();
		const ptyOpen = recording.filter((i) => i.kind === "pty-open");
		expect(ptyOpen.length).toBe(1);
		expect(ptyOpen[0]).toMatchObject({
			kind: "pty-open",
			ptyId: "test-pty",
			cursor: 0,
		});

		const ptyOutput = recording.filter((i) => i.kind === "pty-output");
		expect(ptyOutput.length).toBeGreaterThanOrEqual(1);
		// Should NOT contain the 0x00 cursor metadata frame
		const ptyOutputData = ptyOutput.map((o) => (o as { data: string }).data);
		expect(ptyOutputData).not.toContain(expect.stringContaining("\x00"));

		const ptyInput = recording.filter((i) => i.kind === "pty-input");
		expect(ptyInput.length).toBe(1);
		expect(ptyInput[0]).toMatchObject({
			kind: "pty-input",
			ptyId: "test-pty",
			data: "ls -la",
		});
	});

	it("clears recordings on reset()", () => {
		expect(proxy.getRecording().length).toBeGreaterThan(0);
		proxy.reset();
		expect(proxy.getRecording().length).toBe(0);
	});
});
