import { spawn } from "node:child_process";
import { statSync, watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const watchers = [];
let stopping = false;
let pending = false;
let timer;
let activeBuild;
let builder;
let child;
let childClosed;
let vite;
let viteClosed;
let mode;
let rpc;
let resolveStopped;
const stopped = new Promise((resolve) => {
	resolveStopped = resolve;
});
const log = (message) => console.log(`[dev] ${message}`);

function stop() {
	if (stopping) return;
	stopping = true;
	clearTimeout(timer);
	for (const watcher of watchers) watcher.close();
	// A half-finished build is useless; stop its whole process group.
	if (builder?.exitCode === null) {
		try {
			process.kill(-builder.pid, "SIGTERM");
		} catch {}
	}
	// Vite closes its own esbuild helper; killing the group makes that crash.
	if (vite?.exitCode === null) vite.kill("SIGTERM");
	resolveStopped();
}

function fail(error) {
	console.error(`[dev] ${error.message ?? error}`);
	process.exitCode = 1;
	stop();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function build() {
	log("building");
	// Separate process groups let this script finish cleanup on terminal Ctrl-C.
	builder = spawn("pnpm", ["build"], {
		stdio: "inherit",
		detached: true,
	});
	return new Promise((resolve, reject) => {
		builder.once("error", reject);
		builder.once("close", (code) => resolve(code ?? 1));
	}).finally(() => {
		builder = undefined;
	});
}

async function stopChild() {
	const server = child;
	const closed = childClosed;
	child = undefined;
	if (server?.exitCode === null && server.signalCode === null) {
		server.kill("SIGINT");
	}
	await closed;
}

async function waitForServer(previousSocket) {
	const deadline = Date.now() + 10_000;
	let disconnected = previousSocket === undefined;
	while (!stopping && Date.now() < deadline) {
		const running = await rpc.isDaemonRunning(rpc.DEFAULT_SOCKET_PATH);
		if (!running) disconnected = true;
		const inode = statSync(rpc.DEFAULT_SOCKET_PATH, {
			throwIfNoEntry: false,
		})?.ino;
		if (
			running &&
			inode !== undefined &&
			(disconnected || inode !== previousSocket)
		) {
			return true;
		}
		await delay(100);
	}
	return false;
}

async function restart() {
	log("restarting");
	if (mode === "child") {
		await stopChild();
	} else if (await rpc.isDaemonRunning(rpc.DEFAULT_SOCKET_PATH)) {
		if (stopping) return;
		const inode = statSync(rpc.DEFAULT_SOCKET_PATH, {
			throwIfNoEntry: false,
		})?.ino;
		await rpc.sendRpcRequest(
			rpc.DEFAULT_SOCKET_PATH,
			new rpc.RestartWithConfig({}),
		);
		if (await waitForServer(inode)) {
			if (mode !== "service") {
				log("dev:all is driving the conduit service");
			}
			mode = "service";
			return;
		}
	}
	if (stopping) return;
	mode = "child";
	const server = spawn(
		process.execPath,
		["dist/src/bin/cli.js", "serve", ...args],
		{
			stdio: "inherit",
			detached: true,
		},
	);
	child = server;
	childClosed = new Promise((resolve) => server.once("close", resolve));
	server.once("error", fail);
	server.once("exit", (code, signal) => {
		if (child === server && !stopping) {
			fail(new Error(`server exited (${signal ?? code})`));
		}
	});
	if (!(await waitForServer()) && !stopping) {
		throw new Error("server did not become ready within 10s");
	}
}

/** Instant UI reload on top of whichever server dev:all drives. */
async function startVite() {
	const { port, tlsEnabled } = await rpc.sendRpcRequest(
		rpc.DEFAULT_SOCKET_PATH,
		new rpc.GetStatus({}),
	);
	if (stopping) return;
	const server = `${tlsEnabled ? "https" : "http"}://localhost:${port}`;
	vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
		stdio: "inherit",
		detached: true,
		env: { ...process.env, CONDUIT_DEV_SERVER: server },
	});
	viteClosed = new Promise((resolve) => vite.once("close", resolve));
	vite.once("error", fail);
}

async function rebuild() {
	do {
		pending = false;
		const code = await build();
		if (stopping) return;
		if (code !== 0) {
			log("build failed");
			if (!rpc) {
				process.exitCode = code;
				stop();
			}
		} else {
			if (!rpc) {
				const [
					{ DEFAULT_SOCKET_PATH },
					{ isDaemonRunning },
					{ sendRpcRequest },
					{ GetStatus, RestartWithConfig },
				] = await Promise.all([
					import("../dist/src/bin/cli-utils.js"),
					import("../dist/src/lib/daemon/daemon-utils.js"),
					import("../dist/src/lib/daemon/daemon-rpc-client.js"),
					import("../dist/src/lib/contracts/ws-rpc.js"),
				]);
				rpc = {
					DEFAULT_SOCKET_PATH,
					isDaemonRunning,
					sendRpcRequest,
					GetStatus,
					RestartWithConfig,
				};
			}
			if (stopping) return;
			await restart();
			if (!stopping) {
				log(`ready (${mode}${child ? ` PID ${child.pid}` : ""})`);
				if (!vite) await startVite();
			}
		}
	} while (pending && !stopping);
}

function runBuild() {
	activeBuild = rebuild()
		.catch(fail)
		.finally(() => {
			activeBuild = undefined;
		});
	return activeBuild;
}

function changed() {
	if (stopping) return;
	clearTimeout(timer);
	if (activeBuild) pending = true;
	else timer = setTimeout(runBuild, 300);
}

try {
	watchers.push(
		watch("src", { recursive: true }, (_event, filename) => {
			if (
				filename &&
				(/\.(test|stories)\.ts$/.test(filename) ||
					/(^|[/\\])(__snapshots__|dist)([/\\]|$)/.test(filename))
			) {
				return;
			}
			changed();
		}),
	);
	watchers.push(
		watch("scripts", (_event, filename) => {
			if (filename === "build.mjs") changed();
		}),
	);
	watchers.push(
		watch(".", (_event, filename) => {
			if (filename === "vite.config.ts" || filename === "package.json")
				changed();
		}),
	);
	for (const watcher of watchers) watcher.on("error", fail);
	await runBuild();
	await stopped;
} catch (error) {
	fail(error);
} finally {
	stop();
	await activeBuild;
	await Promise.all([stopChild(), viteClosed]);
}
