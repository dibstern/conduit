#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
const server = createServer((request, response) => {
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
		const sessionsFile = join(configDir, "fake-opencode-sessions.json");
		const sessions = existsSync(sessionsFile)
			? JSON.parse(readFileSync(sessionsFile, "utf8"))
			: [];
		response.end(JSON.stringify(sessions));
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
	} else if (
		request.url === "/global/event" ||
		request.url?.startsWith("/event")
	) {
		response.setHeader("Content-Type", "text/event-stream");
		response.write('data: {"type":"server.connected","properties":{}}\n\n');
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
