import { readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";

/** Drop only the server's host transport; the real host and browser stay alive. */
export async function createPtySocketProxy(root: string, target: string) {
	if (
		!root.startsWith("/tmp/conduit-process-") ||
		!realpathSync(target).startsWith(`${realpathSync(root)}/`)
	) {
		throw new Error("PTY proxy requires isolated process harness paths");
	}
	const path = join(root, "config", "pty.sock");
	const sockets = new Set<Socket>();
	const pending = new Set<Socket>();
	let paused = false;
	let connections = 0;
	let dropList = false;
	let listDrops = 0;
	const forward = (downstream: Socket) => {
		const upstream = connect(target);
		let requests = "";
		sockets.add(upstream);
		connections++;
		upstream.on("error", () => downstream.destroy());
		downstream.on("error", () => upstream.destroy());
		upstream.on("close", () => {
			sockets.delete(upstream);
			downstream.destroy();
		});
		downstream.on("close", () => upstream.destroy());
		downstream.on("data", (data: Buffer) => {
			requests += data.toString("utf8");
			let newline = requests.indexOf("\n");
			while (newline !== -1) {
				const line = requests.slice(0, newline);
				requests = requests.slice(newline + 1);
				const message: unknown = JSON.parse(line);
				if (
					dropList &&
					message !== null &&
					typeof message === "object" &&
					"type" in message &&
					message.type === "list"
				) {
					dropList = false;
					listDrops++;
					downstream.unpipe(upstream);
					upstream.unpipe(downstream);
					downstream.destroy();
					upstream.destroy();
					return;
				}
				newline = requests.indexOf("\n");
			}
		});
		downstream.pipe(upstream);
		upstream.pipe(downstream);
	};
	const server = createServer((downstream) => {
		sockets.add(downstream);
		downstream.on("error", () => downstream.destroy());
		downstream.on("close", () => {
			sockets.delete(downstream);
			pending.delete(downstream);
		});
		if (paused) pending.add(downstream);
		else forward(downstream);
	});
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(path, () => {
			server.off("error", fail);
			done();
		});
	});
	return {
		get connections() {
			return connections;
		},
		get listDrops() {
			return listDrops;
		},
		dropNextList() {
			dropList = true;
		},
		drop() {
			paused = true;
			for (const socket of sockets) socket.destroy();
		},
		resume() {
			paused = false;
			for (const downstream of pending) forward(downstream);
			pending.clear();
		},
		async dispose() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((done) => server.close(() => done()));
			try {
				unlinkSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const root = process.argv[2];
	const dist = process.argv[3];
	if (
		!root ||
		!dist ||
		!root.startsWith("/tmp/conduit-process-") ||
		process.env["HOME"] !== join(root, "home") ||
		process.env["CONDUIT_CONFIG_DIR"] !== join(root, "config")
	) {
		throw new Error(
			"PTY host fixture requires the process harness's isolated home and build",
		);
	}
	const { runPtyHost } = (await import(
		pathToFileURL(join(dist, "src/lib/terminal/pty-host.js")).href
	)) as typeof import("../../src/lib/terminal/pty-host.js");
	const {
		PTY_HOST_PROTOCOL_VERSION,
		PtyHostMessageSchema,
		ptyHostSocketPath,
		readPtyFrames,
		writePtyFrame,
	} = (await import(
		pathToFileURL(join(dist, "src/lib/terminal/pty-host-protocol.js")).href
	)) as typeof import("../../src/lib/terminal/pty-host-protocol.js");
	const configDir = join(root, "config");
	const socketPath = ptyHostSocketPath(configDir);
	let finished = false;
	let teardown: Promise<void> | undefined;
	const stopOwnedGeneration = async (): Promise<void> => {
		while (!finished) {
			let target: string;
			try {
				target = readlinkSync(socketPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await new Promise((done) => setTimeout(done, 20));
				continue;
			}
			if (!/^h-[0-9a-f-]{36}$/.test(target)) return;
			// Connect to the observed generation, not the replaceable public path.
			await new Promise<void>((done, reject) => {
				const socket = connect(join(dirname(socketPath), target));
				const fail = (error: Error) => {
					socket.destroy();
					reject(error);
				};
				socket.setTimeout(2000, () =>
					fail(new Error("Fixture host stop timed out")),
				);
				socket.once("connect", () => {
					writePtyFrame(socket, {
						type: "hello",
						protocolVersion: PTY_HOST_PROTOCOL_VERSION,
						buildId: process.argv[4] ?? "85kb-idle-old",
					});
				});
				socket.once("error", (error) => {
					if (
						["ENOENT", "ECONNREFUSED"].includes(
							(error as NodeJS.ErrnoException).code ?? "",
						)
					)
						done();
					else fail(error);
				});
				socket.once("close", done);
				readPtyFrames(
					socket,
					Schema.decodeUnknownSync(PtyHostMessageSchema),
					(message) => {
						if (message.type === "hello") {
							if (
								message.pid !== process.pid ||
								message.protocolVersion !== PTY_HOST_PROTOCOL_VERSION
							) {
								socket.end();
								return;
							}
							writePtyFrame(socket, {
								type: "stop",
								requestId: 1,
								force: true,
							});
						} else if (message.type === "stopped" && !message.stopped) {
							fail(new Error("Fixture host refused forced stop"));
						}
					},
					fail,
				);
			});
			return;
		}
	};
	const requestTeardown = (): void => {
		teardown ??= stopOwnedGeneration().catch((error: unknown) =>
			console.error(error),
		);
	};
	process.once("disconnect", requestTeardown);
	process.once("SIGTERM", requestTeardown);
	process.once("SIGINT", requestTeardown);
	process.umask(0o022);
	try {
		await runPtyHost({
			configDir,
			buildId: process.argv[4] ?? "85kb-idle-old",
		});
	} finally {
		finished = true;
		process.off("disconnect", requestTeardown);
		process.off("SIGTERM", requestTeardown);
		process.off("SIGINT", requestTeardown);
		if (process.connected) process.disconnect?.();
		await teardown;
	}
}
