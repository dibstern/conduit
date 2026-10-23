#!/usr/bin/env node
// Stands in for `opencode` on the managed supervisor's PATH when the process
// harness runs the real binary. It starts the real OpenCode (linked at
// <root>/bin/opencode-real) on a private port and proxies the port the
// supervisor asked for, writing the same request, stream-connection and PID
// ledgers as the fake. Both processes stay in the supervisor's process group,
// so an idle stop signals the real binary directly.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import { join } from "node:path";

const configDir = process.env.CONDUIT_CONFIG_DIR;
const root = configDir ? join(configDir, "..") : "";
if (!configDir || process.env.HOME !== join(root, "home")) {
	throw new Error("Real OpenCode proxy requires the isolated process harness");
}
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const log = (file, entry) =>
	appendFileSync(
		join(configDir, file),
		`${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`,
	);

// Every OpenCode data, config, state and cache path stays inside the root.
// Match ProcessBrowser's model selection without fetching a public catalog.
const modelsPath = join(root, "opencode-models.json");
writeFileSync(modelsPath, "{}");
// OpenCode's --port 0 tries 4096 first, where unrelated clients may attach.
const reservation = createServer();
await new Promise((resolve, reject) => {
	reservation.once("error", reject);
	reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
if (!address || typeof address === "string")
	throw new Error("Missing private OpenCode port");
await new Promise((resolve, reject) =>
	reservation.close((error) => (error ? reject(error) : resolve())),
);
const real = spawn(
	join(root, "bin", "opencode-real"),
	["serve", "--hostname", "127.0.0.1", "--port", String(address.port)],
	{
		env: {
			...process.env,
			// The fixture's provider and plugin are local; don't fetch npm dependencies.
			npm_config_offline: "true",
			OPENCODE_MODELS_PATH: modelsPath,
			OPENCODE_DISABLE_MODELS_FETCH: "true",
			OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				provider: {
					fake: {
						name: "Lifecycle fixture",
						npm: "@ai-sdk/openai-compatible",
						options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1" },
						models: {
							"fake-model": {
								name: "Lifecycle fixture model",
								limit: { context: 128_000, output: 8_000 },
							},
						},
					},
				},
				...JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
			}),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_CACHE_HOME: join(root, "cache"),
		},
		stdio: ["ignore", "pipe", "inherit"],
	},
);
real.once("exit", (code) => process.exit(code ?? 1));
log("fake-opencode-pids.jsonl", {
	childPid: real.pid,
	groupPid: Number(process.env.CONDUIT_OPENCODE_GROUP_PID ?? process.pid),
});

let upstream;
real.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
	if (match) upstream = Number(match[1]);
});

let connections = 0;
const streams = new Map();
const closeStream = (connectionId, reason) => {
	const path = streams.get(connectionId);
	if (!streams.delete(connectionId)) return;
	log("fake-opencode-stream-connections.jsonl", {
		action: "close",
		connectionId,
		path,
		reason,
	});
};

createServer((request, response) => {
	const path = request.url?.split("?")[0];
	log("fake-opencode-requests.jsonl", {
		method: request.method,
		url: request.url,
		directory: request.headers["x-opencode-directory"],
	});
	// The supervisor and daemon retry health until the real server listens.
	if (!upstream) {
		response.writeHead(503).end();
		return;
	}
	let upstreamEnded = false;
	const proxied = forward(
		{
			host: "127.0.0.1",
			port: upstream,
			method: request.method,
			path: request.url,
			headers: request.headers,
		},
		(answer) => {
			// Keep creation evidence before a later move can hide the initial cwd.
			if (
				request.method === "POST" &&
				(path === "/session" || path === "/api/session")
			) {
				let body = "";
				answer.on("data", (chunk) => {
					body += String(chunk);
				});
				answer.once("end", () => {
					if (answer.statusCode !== 200) return;
					const parsed = JSON.parse(body);
					const session = path === "/api/session" ? parsed.data : parsed;
					log("real-opencode-session-creations.jsonl", {
						id: session.id,
						directory: session.directory ?? session.location?.directory,
					});
				});
			}
			response.writeHead(answer.statusCode ?? 502, answer.headers);
			response.flushHeaders();
			answer.once("end", () => {
				upstreamEnded = true;
			});
			answer.pipe(response);
		},
	);
	proxied.once("error", () => {
		if (!response.headersSent) response.writeHead(502);
		response.end();
	});
	request.pipe(proxied);
	if (path !== "/global/event" && path !== "/event") return;
	const connectionId = ++connections;
	streams.set(connectionId, path);
	log("fake-opencode-stream-connections.jsonl", {
		action: "open",
		connectionId,
		path,
	});
	response.once("close", () => {
		closeStream(connectionId, upstreamEnded ? "upstream" : "client");
		proxied.destroy();
	});
}).listen(port, "127.0.0.1");

// The group stop signals both processes. Let in-flight closes log first.
process.on("SIGTERM", () => {
	setTimeout(() => {
		for (const connectionId of [...streams.keys()])
			closeStream(connectionId, "terminated");
		process.exit(0);
	}, 100);
});
