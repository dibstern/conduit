#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readdirSync,
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
writeFileSync(
	join(configDir, "fake-opencode-worktree-env.json"),
	JSON.stringify({
		OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
		CONDUIT_DAEMON_SOCKET: process.env.CONDUIT_DAEMON_SOCKET,
		CONDUIT_OPENCODE_INSTANCE_ID: process.env.CONDUIT_OPENCODE_INSTANCE_ID,
	}),
);
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
let silenceReconnect = false;
// While set, /session/status samples at arrival but answers only on release.
let statusHold;
// Multiple instances in one harness can opt into separate provider stores.
const statePrefix = process.env.CONDUIT_TEST_OPENCODE_STATE_PREFIX;
const stateStem = statePrefix
	? `fake-opencode-${statePrefix}`
	: "fake-opencode";
const sessionsFile = join(configDir, `${stateStem}-sessions.json`);
const sessions = () =>
	existsSync(sessionsFile)
		? JSON.parse(readFileSync(sessionsFile, "utf8"))
		: [];
// Per-directory status and pending prompts, kept in a file so they survive a
// managed restart like sessions do. Idle sessions are absent, as in OpenCode.
const stateFile = join(configDir, `${stateStem}-state.json`);
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
// Removes an answered prompt from whichever directory asked it; returns that
// directory.
const answerPrompt = (kind, requestID) => {
	let owner;
	updateState((state) => {
		for (const [directory, items] of Object.entries(state[kind])) {
			if (!items.some(({ id }) => id === requestID)) continue;
			owner = directory;
			state[kind][directory] = items.filter(({ id }) => id !== requestID);
		}
	});
	return owner;
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
	// OpenCode resolves an existing session's stored directory before query cwd.
	const sessionID = /^\/session\/([^/]+)/.exec(path)?.[1];
	const stored = sessionID && sessions().find(({ id }) => id === sessionID);
	if (stored?.directory) directory = stored.directory;
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
	if (path === "/test/hold-status" && request.method === "POST") {
		let release;
		const released = new Promise((done) => {
			release = done;
		});
		statusHold = { released, release };
		response.end("{}");
		return;
	}
	if (path === "/test/release-status" && request.method === "POST") {
		statusHold?.release();
		statusHold = undefined;
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
	if (path === "/test/fail-delete" && request.method === "POST") {
		const input = JSON.parse(body);
		updateState((state) => {
			state.failedDeletes = [...(state.failedDeletes ?? []), input.sessionID];
		});
		response.end("{}");
		return;
	}
	if (path === "/test/close-streams" && request.method === "POST") {
		silenceReconnect = JSON.parse(body).silenceReconnect === true;
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
				...(input.parentID ? { parentID: input.parentID } : {}),
				time: { created: Date.now(), updated: Date.now() },
			};
			writeFileSync(sessionsFile, JSON.stringify([...sessions(), session]));
			response.end(JSON.stringify(session));
			emitTyped(directory, "session.created", { info: session });
		} else {
			response.end(
				JSON.stringify(
					sessions().filter(
						(session) => !directory || session.directory === directory,
					),
				),
			);
		}
	} else if (
		/^\/session\/[^/]+\/fork$/.test(path) &&
		request.method === "POST"
	) {
		const parent = sessions().find(({ id }) => id === path.split("/")[2]);
		if (!parent) {
			response.writeHead(404).end("{}");
			return;
		}
		const session = {
			...parent,
			id: `ses_${randomUUID()}`,
			parentID: parent.id,
			time: { created: Date.now(), updated: Date.now() },
		};
		writeFileSync(sessionsFile, JSON.stringify([...sessions(), session]));
		response.end(JSON.stringify(session));
		emitTyped(directory, "session.created", { info: session });
	} else if (
		path === "/experimental/control-plane/move-session" &&
		request.method === "POST"
	) {
		const input = JSON.parse(body || "{}");
		const previous = sessions().find(({ id }) => id === input.sessionID);
		if (!previous) {
			response.writeHead(404).end("{}");
			return;
		}
		if (
			input.moveChanges !== false ||
			typeof input.destination?.directory !== "string"
		) {
			response.writeHead(400).end("{}");
			return;
		}
		const moved = {
			...previous,
			directory: canonical(input.destination.directory),
			time: { ...previous.time, updated: Date.now() },
		};
		writeFileSync(
			sessionsFile,
			JSON.stringify(
				sessions().map((session) =>
					session.id === moved.id ? moved : session,
				),
			),
		);
		response.writeHead(204).end();
	} else if (request.url === "/global/health") {
		if (!healthy || existsSync(join(configDir, `${stateStem}-hold-health`))) {
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
		if (existsSync(join(configDir, "fake-opencode-reject-events"))) {
			response.writeHead(503).end("{}");
			return;
		}
		const stream = {
			connectionId: ++streamId,
			path,
			...(directory ? { directory } : {}),
		};
		streams.set(response, stream);
		streamLog("open", stream);
		response.setHeader("Content-Type", "text/event-stream");
		response.flushHeaders();
		const write = (type) => {
			if (silenceReconnect) return;
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
		const statuses = JSON.stringify(
			(directory && readState().statuses[directory]) || {},
		);
		if (statusHold) {
			appendFileSync(
				join(configDir, "fake-opencode-held-status.jsonl"),
				`${JSON.stringify({ pid: process.pid, at: Date.now(), directory, statuses })}\n`,
			);
			await statusHold.released;
		}
		response.end(statuses);
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
		const owner = answerPrompt("permissions", requestID);
		if (owner)
			emitTyped(owner, "permission.replied", {
				sessionID: path.split("/")[2],
				requestID,
				reply: JSON.parse(body || "{}").response,
			});
		response.end("true");
	} else if (
		/^\/question\/[^/]+\/(reply|reject)$/.test(path) &&
		request.method === "POST"
	) {
		const [, , requestID, action] = path.split("/");
		// A root question route uses its requested directory, or process cwd.
		const owner = directory ?? canonical(process.cwd());
		const pending = (readState().questions[owner] ?? []).find(
			({ id }) => id === requestID,
		);
		if (!pending) {
			response.writeHead(404).end("{}");
			return;
		}
		updateState((state) => {
			state.questions[owner] = state.questions[owner].filter(
				({ id }) => id !== requestID,
			);
		});
		emitTyped(
			owner,
			action === "reply" ? "question.replied" : "question.rejected",
			{ sessionID: pending.sessionID, requestID },
		);
		response.end("true");
	} else if (/^\/session\/[^/]+\/message$/.test(path)) {
		const sessionID = path.split("/")[2];
		const failureFile = join(configDir, "fake-opencode-history-failures.json");
		const failures = existsSync(failureFile)
			? JSON.parse(readFileSync(failureFile, "utf8"))
			: {};
		// true keeps failures active until the test removes the entry.
		if (failures[sessionID] === true || failures[sessionID] > 0) {
			if (failures[sessionID] !== true) {
				failures[sessionID]--;
				writeFileSync(failureFile, JSON.stringify(failures));
			}
			appendFileSync(
				join(configDir, "fake-opencode-history-failures.jsonl"),
				`${JSON.stringify({ pid: process.pid, at: Date.now(), sessionID })}\n`,
			);
			response.writeHead(503).end('{"message":"Injected history failure"}');
		} else {
			response.end("[]");
		}
	} else if (["/agent", "/command"].includes(path)) {
		const discoveryFile = join(configDir, "fake-opencode-discovery.json");
		const discovery = existsSync(discoveryFile)
			? JSON.parse(readFileSync(discoveryFile, "utf8"))
			: {};
		response.end(
			JSON.stringify(
				path === "/agent"
					? (discovery.agents ?? [])
					: (discovery.commands ?? []),
			),
		);
	} else if (/^\/session\/[^/]+$/.test(path)) {
		const session = sessions().find(({ id }) => path === `/session/${id}`);
		if (request.method === "PATCH" && session) {
			const input = JSON.parse(body || "{}");
			const updated = {
				...session,
				...(input.title !== undefined && { title: input.title }),
				...(input.permission !== undefined && { permission: input.permission }),
				time: { ...session.time, updated: Date.now() },
			};
			writeFileSync(
				sessionsFile,
				JSON.stringify(
					sessions().map((value) =>
						value.id === updated.id ? updated : value,
					),
				),
			);
			response.end(JSON.stringify(updated));
			return;
		}
		if (request.method === "DELETE") {
			if ((readState().failedDeletes ?? []).includes(session?.id)) {
				response
					.writeHead(503)
					.end(JSON.stringify({ message: "Delete failed" }));
				return;
			}
			if (!session) {
				response.writeHead(404).end("{}");
				return;
			}
			writeFileSync(
				sessionsFile,
				JSON.stringify(sessions().filter(({ id }) => id !== session.id)),
			);
			updateState((state) => {
				delete state.statuses[session.directory]?.[session.id];
				for (const kind of ["permissions", "questions"])
					state[kind][session.directory] = (
						state[kind][session.directory] ?? []
					).filter(({ sessionID }) => sessionID !== session.id);
			});
			response.end("true");
			emitTyped(session.directory, "session.deleted", { info: session });
			return;
		}
		response.end(JSON.stringify(session ?? {}));
	} else if (path === "/file" || path === "/file/content") {
		try {
			const discoveryFile = join(configDir, "fake-opencode-discovery.json");
			const discovery = existsSync(discoveryFile)
				? JSON.parse(readFileSync(discoveryFile, "utf8"))
				: {};
			if (path === "/file" && discovery.files !== undefined) {
				response.end(JSON.stringify(discovery.files));
				return;
			}
			const target = join(
				directory ?? configDir,
				url.searchParams.get("path") ?? ".",
			);
			response.end(
				JSON.stringify(
					path === "/file"
						? readdirSync(target, { withFileTypes: true }).map((entry) => ({
								name: entry.name,
								path: entry.name,
								absolute: join(target, entry.name),
								type: entry.isDirectory() ? "directory" : "file",
								ignored: false,
							}))
						: { type: "text", content: readFileSync(target, "utf8") },
				),
			);
		} catch {
			response.writeHead(404).end(
				JSON.stringify({
					name: "NotFoundError",
					data: { message: "File not found" },
				}),
			);
		}
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
		const projectConfig = join(directory ?? process.cwd(), "opencode.json");
		response.end(
			existsSync(projectConfig) ? readFileSync(projectConfig, "utf8") : "{}",
		);
	} else if (path === "/provider" && request.method === "GET") {
		if (existsSync(join(configDir, `${stateStem}-reject-models`))) {
			response.writeHead(503).end("{}");
			return;
		}
		const catalogFile = join(configDir, `${stateStem}-model-catalog.json`);
		response.end(
			existsSync(catalogFile)
				? readFileSync(catalogFile, "utf8")
				: JSON.stringify({
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
