#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const configDir = process.env.CONDUIT_CONFIG_DIR;
if (!configDir || process.env.HOME !== join(configDir, "..", "home")) {
	throw new Error("Fake OpenCode requires the isolated process harness");
}
const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.split("=")[1] ?? args[args.indexOf("--port") + 1]);
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const groupPid = Number(process.env.CONDUIT_OPENCODE_GROUP_PID ?? process.pid);
let healthy = true;
if (process.env.CONDUIT_TEST_OPENCODE_PAUSE_SUPERVISOR === "true") {
	healthy = false;
	setTimeout(() => {
		if (process.ppid !== groupPid) throw new Error("Supervisor must be parent");
		process.kill(process.ppid, "SIGSTOP");
	}, 200);
}
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
});
appendFileSync(
	join(configDir, "fake-opencode-pids.jsonl"),
	`${JSON.stringify({ pid: process.pid, childPid: child.pid, groupPid })}\n`,
);
const streams = new Map();
let streamId = 0;
const sessionsFile = join(configDir, "fake-opencode-sessions.json");
const sessions = () =>
	existsSync(sessionsFile)
		? JSON.parse(readFileSync(sessionsFile, "utf8"))
		: [];
const streamLog = (action, stream) =>
	appendFileSync(
		join(configDir, "fake-opencode-stream-connections.jsonl"),
		`${JSON.stringify({ pid: process.pid, at: Date.now(), action, ...stream })}\n`,
	);
const server = createServer(async (request, response) => {
	if (password && request.headers.authorization !== authorization) {
		if (request.url?.split("?")[0] === "/session") {
			appendFileSync(
				join(configDir, "fake-opencode-session-requests.jsonl"),
				`${JSON.stringify({ authenticated: false, directory: request.headers["x-opencode-directory"] })}\n`,
			);
		}
		response.writeHead(401).end();
		return;
	}
	response.setHeader("Content-Type", "application/json");
	const url = new URL(request.url, "http://127.0.0.1");
	const path = url.pathname;
	let directory =
		url.searchParams.get("directory") ??
		request.headers["x-opencode-directory"];
	if (directory) {
		try {
			directory = realpathSync(decodeURIComponent(directory));
		} catch {
			/* Test directory may already be removed. */
		}
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	if (body)
		appendFileSync(
			join(configDir, "fake-opencode-request-bodies.jsonl"),
			`${JSON.stringify({ method: request.method, path, body })}\n`,
		);
	if (path === "/test/emit-event" && request.method === "POST") {
		const envelope = JSON.parse(body);
		for (const [client, stream] of streams) {
			if (stream.path === "/global/event")
				client.write(`data: ${JSON.stringify(envelope)}\n\n`);
			else if (stream.directory === envelope.directory)
				client.write(`data: ${JSON.stringify(envelope.payload)}\n\n`);
		}
		response.end("{}");
		return;
	}
	if (path === "/test/close-streams" && request.method === "POST") {
		for (const client of streams.keys()) client.end();
		response.end("{}");
		return;
	}
	if (request.url === "/test/fail-health" && request.method === "POST") {
		healthy = false;
		response.end("{}");
		return;
	}
	if (request.url === "/test/close-listener" && request.method === "POST") {
		response.end("{}", () => {
			server.close();
			server.closeAllConnections();
		});
		return;
	}
	if (request.url?.split("?")[0] === "/session") {
		appendFileSync(
			join(configDir, "fake-opencode-session-requests.jsonl"),
			`${JSON.stringify({ authenticated: true, directory: request.headers["x-opencode-directory"] })}\n`,
		);
		if (request.method === "POST") {
			const input = JSON.parse(body || "{}");
			const session = {
				id: `ses_${randomUUID()}`,
				slug: "fake-session",
				version: "1.18.34",
				projectID: "global",
				directory,
				title: input.title ?? "Fake session",
				time: { created: Date.now(), updated: Date.now() },
			};
			writeFileSync(sessionsFile, JSON.stringify([...sessions(), session]));
			response.end(JSON.stringify(session));
		} else {
			response.end(
				JSON.stringify(
					sessions().filter(
						(session) => !directory || session.directory === directory,
					),
				),
			);
		}
	} else if (request.url === "/global/health") {
		if (!healthy) {
			response.writeHead(503).end("{}");
			return;
		}
		response.end(
			JSON.stringify({
				healthy: true,
				version: "fake-85kb.12",
				pid: process.pid,
				childPid: child.pid,
				groupPid,
			}),
		);
	} else if (path === "/global/event" || path === "/event") {
		const stream = {
			connectionId: ++streamId,
			path,
			...(directory ? { directory } : {}),
		};
		streams.set(response, stream);
		streamLog("open", stream);
		response.setHeader("Content-Type", "text/event-stream");
		const write = (type) => {
			const payload = { id: `evt_${randomUUID()}`, type, properties: {} };
			response.write(
				`data: ${JSON.stringify(path === "/global/event" ? { payload } : payload)}\n\n`,
			);
		};
		write("server.connected");
		const heartbeat = setInterval(() => write("server.heartbeat"), 10_000);
		response.on("close", () => {
			clearInterval(heartbeat);
			streams.delete(response);
			streamLog("close", stream);
		});
	} else if (path === "/session/status") {
		response.end("{}");
	} else if (/^\/session\/[^/]+$/.test(path)) {
		response.end(
			JSON.stringify(
				sessions().find(({ id }) => path === `/session/${id}`) ?? {},
			),
		);
	} else if (path === "/path") {
		response.end(
			JSON.stringify({
				state: configDir,
				config: configDir,
				worktree: directory ?? configDir,
				directory: directory ?? configDir,
			}),
		);
	} else if (path === "/config") {
		response.end("{}");
	} else {
		response.end("[]");
	}
});
const listen = () =>
	server.listen(port, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing port");
		console.log(
			`opencode server listening on http://127.0.0.1:${address.port}`,
		);
		console.error("fake OpenCode stderr is captured");
	});
const listenDelay = Number(
	process.env.CONDUIT_TEST_OPENCODE_LISTEN_DELAY_MS ?? 0,
);
if (listenDelay > 0) setTimeout(listen, listenDelay);
else listen();
if (process.env.CONDUIT_TEST_OPENCODE_IGNORE_SIGTERM === "true") {
	process.on("SIGTERM", () => {});
}
