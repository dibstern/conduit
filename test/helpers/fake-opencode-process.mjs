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
// Per-directory status and pending prompts, kept in a file so they survive a
// managed restart like sessions do. Idle sessions are absent, as in OpenCode.
const stateFile = join(configDir, "fake-opencode-state.json");
const readState = () =>
	existsSync(stateFile)
		? JSON.parse(readFileSync(stateFile, "utf8"))
		: { statuses: {}, permissions: {}, questions: {}, drops: [] };
const updateState = (update) => {
	const state = readState();
	update(state);
	writeFileSync(stateFile, JSON.stringify(state));
};
const canonical = (directory) => {
	try {
		return realpathSync(directory);
	} catch {
		return directory;
	}
};
// A drop rule matches on event type and, for session.status, the status type.
const dropped = (payload) =>
	readState().drops.some(
		(rule) =>
			rule.type === payload.type &&
			(rule.status === undefined ||
				rule.status === payload.properties?.status?.type),
	);
const emit = (envelope) => {
	if (envelope?.payload && dropped(envelope.payload)) {
		appendFileSync(
			join(configDir, "fake-opencode-dropped-events.jsonl"),
			`${JSON.stringify({ pid: process.pid, at: Date.now(), ...envelope })}\n`,
		);
		return;
	}
	for (const [client, stream] of streams) {
		if (stream.path === "/global/event")
			client.write(`data: ${JSON.stringify(envelope)}\n\n`);
		else if (stream.directory === envelope.directory)
			client.write(`data: ${JSON.stringify(envelope.payload)}\n\n`);
	}
};
const emitTyped = (directory, type, properties) =>
	emit({
		directory,
		payload: { id: `evt_${randomUUID()}`, type, properties },
	});
const streamLog = (action, stream) =>
	appendFileSync(
		join(configDir, "fake-opencode-stream-connections.jsonl"),
		`${JSON.stringify({ pid: process.pid, at: Date.now(), action, ...stream })}\n`,
	);
const server = createServer(async (request, response) => {
	appendFileSync(
		join(configDir, "fake-opencode-requests.jsonl"),
		`${JSON.stringify({ pid: process.pid, at: Date.now(), method: request.method, url: request.url, directory: request.headers["x-opencode-directory"] })}\n`,
	);
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
			`${JSON.stringify({ pid: process.pid, method: request.method, path, body })}\n`,
		);
	if (path === "/test/emit-event" && request.method === "POST") {
		emit(JSON.parse(body));
		response.end("{}");
		return;
	}
	if (path === "/test/set-status" && request.method === "POST") {
		const input = JSON.parse(body);
		const target = canonical(input.directory);
		updateState((state) => {
			const statuses = (state.statuses[target] ??= {});
			if (input.status.type === "idle") delete statuses[input.sessionID];
			else statuses[input.sessionID] = input.status;
		});
		emitTyped(target, "session.status", {
			sessionID: input.sessionID,
			status: input.status,
		});
		response.end("{}");
		return;
	}
	if (
		(path === "/test/add-permission" || path === "/test/add-question") &&
		request.method === "POST"
	) {
		const input = JSON.parse(body);
		const target = canonical(input.directory);
		const kind = path === "/test/add-permission" ? "permissions" : "questions";
		updateState((state) => {
			state[kind][target] = [...(state[kind][target] ?? []), input.item];
		});
		emitTyped(
			target,
			kind === "permissions" ? "permission.asked" : "question.asked",
			input.item,
		);
		response.end("{}");
		return;
	}
	if (path === "/test/drop-events" && request.method === "POST") {
		const input = JSON.parse(body);
		updateState((state) => {
			state.drops = input.rules;
		});
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
			`${JSON.stringify({ authenticated: true, directory })}\n`,
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
		response.end(
			JSON.stringify((directory && readState().statuses[directory]) || {}),
		);
	} else if (
		(path === "/permission" || path === "/question") &&
		request.method === "GET"
	) {
		// OpenCode 1.18.34 scopes pending prompts by directory; none without one.
		const kind = path === "/permission" ? "permissions" : "questions";
		response.end(
			JSON.stringify((directory && readState()[kind][directory]) || []),
		);
	} else if (
		/^\/session\/[^/]+\/prompt_async$/.test(path) &&
		request.method === "POST"
	) {
		// The turn finishes at once: busy, then idle.
		const sessionID = path.split("/")[2];
		response.writeHead(204).end();
		for (const type of ["busy", "idle"])
			emitTyped(directory, "session.status", { sessionID, status: { type } });
	} else if (
		/^\/session\/[^/]+\/permissions\/[^/]+$/.test(path) &&
		request.method === "POST"
	) {
		const requestID = path.split("/")[4];
		updateState((state) => {
			state.permissions[directory] = (
				state.permissions[directory] ?? []
			).filter(({ id }) => id !== requestID);
		});
		response.end("true");
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
	} else if (path === "/provider" && request.method === "GET") {
		response.end(
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Fake Provider",
						models: {
							"fake-model": {
								id: "fake-model",
								name: "Fake Model",
								limit: { context: 128000, output: 4096 },
							},
						},
					},
				],
				default: { fake: "fake-model" },
				connected: ["fake"],
			}),
		);
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
