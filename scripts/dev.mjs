import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const watchers = [];
let stopping = false;
let pending = false;
let timer;
let activeBuild;
let lastBuildId;
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

/** dev:all outlives a bad cycle; the next change or crash retries it. */
function recover(error) {
	console.error(`[dev] ${error.message ?? error}; waiting for the next change`);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Closing the terminal must not orphan the detached server on its port.
process.on("SIGHUP", stop);

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

/** PIDs listening on the port; empty when there are none or lsof is missing. */
function portHolders(port) {
	const { stdout } = spawnSync(
		"lsof",
		["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
		{ encoding: "utf8" },
	);
	return (stdout ?? "").split("\n").filter(Boolean).map(Number);
}

/**
 * Stops an old conduit server still holding the port (an orphaned dev:all
 * child, a wedged daemon, another config dir) so the child can bind it.
 * Returns true when a supervisor brought the service back on our socket
 * instead; killing it again would only race the respawn, so drive it.
 */
async function freePort(port) {
	const holders = portHolders(port);
	for (const pid of holders) {
		const command = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
			encoding: "utf8",
		}).stdout?.trim();
		if (!command || !/\b(cli\.[jt]s|conduit)\s+serve\b/.test(command)) {
			throw new Error(
				`port ${port} is held by PID ${pid} (${command || "unknown"}), which is not a conduit server; stop it and re-run`,
			);
		}
		log(`stopping old conduit PID ${pid} on port ${port}`);
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	const started = Date.now();
	let forced = false;
	while (holders.length > 0 && !stopping) {
		const current = portHolders(port);
		if (current.length === 0) return false;
		if (
			current.every((pid) => !holders.includes(pid)) &&
			(await rpc.isDaemonRunning(rpc.DEFAULT_SOCKET_PATH))
		) {
			return true;
		}
		const elapsed = Date.now() - started;
		if (elapsed > 15_000) {
			throw new Error(
				`port ${port} is still held by PID ${current.join(", ")}; is it managed by a service on another config dir?`,
			);
		}
		if (elapsed > 10_000 && !forced) {
			forced = true;
			for (const pid of holders) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		await delay(200);
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
		// A daemon busy booting relays can miss the default 10s reply window,
		// yet still restart, so a timeout falls through to the socket check.
		await rpc
			.sendRpcRequest(
				rpc.DEFAULT_SOCKET_PATH,
				{ _tag: "RestartWithConfig" },
				{
					requestTimeoutMs: 60_000,
				},
			)
			.catch((error) => log(`${error.message}; checking for a restart`));
		if (await waitForServer(inode)) {
			if (mode !== "service") {
				log("dev:all is driving the conduit service");
			}
			mode = "service";
			return;
		}
	}
	if (stopping) return;
	if (await freePort(rpc.port)) {
		log("dev:all is driving the conduit service");
		mode = "service";
		return;
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
	server.once("error", recover);
	server.once("exit", (code, signal) => {
		if (child !== server || stopping) return;
		child = undefined;
		log(`server exited (${signal ?? code}); restarting in 2s`);
		// Paced so a server that crashes on boot does not spin.
		delay(2_000).then(() => {
			if (!child) runRestart();
		});
	});
	if (!(await waitForServer()) && !stopping) {
		throw new Error("server did not become ready within 10s");
	}
}

/** Instant UI reload on top of whichever server dev:all drives. */
async function startVite() {
	const { port, tlsEnabled } = await rpc.sendRpcRequest(
		rpc.DEFAULT_SOCKET_PATH,
		{ _tag: "GetStatus" },
	);
	if (stopping || pending) return;
	const server = `${tlsEnabled ? "https" : "http"}://localhost:${port}`;
	// Keep Conduit's startup screen visible while retaining Vite diagnostics.
	vite = spawn(
		process.execPath,
		[
			"node_modules/vite/bin/vite.js",
			"--clearScreen",
			"false",
			"--logLevel",
			"warn",
		],
		{
			stdio: "inherit",
			detached: true,
			env: { ...process.env, CONDUIT_DEV_SERVER: server },
		},
	);
	viteClosed = new Promise((resolve) => vite.once("close", resolve));
	vite.once("error", fail);
}

function readBuildId() {
	try {
		const buildId = JSON.parse(
			readFileSync("dist/build-ready.json", "utf8"),
		)?.buildId;
		return typeof buildId === "string" && buildId ? buildId : undefined;
	} catch {
		return undefined;
	}
}

async function rebuild() {
	do {
		pending = false;
		const code = await build();
		if (stopping) return;
		if (code !== 0) {
			log("build failed; waiting for the next change");
		} else {
			if (!rpc) {
				const [
					{ DEFAULT_CONFIG_DIR, DEFAULT_PORT, DEFAULT_SOCKET_PATH, parseArgs },
					{ loadDaemonConfigResult },
					{ isDaemonRunning },
					{ sendRpcRequest },
				] = await Promise.all([
					import("../dist/src/bin/cli-utils.js"),
					import("../dist/src/lib/daemon/config-persistence.js"),
					import("../dist/src/lib/daemon/daemon-utils.js"),
					import("../dist/src/lib/daemon/daemon-rpc-client.js"),
				]);
				// The port `serve` will bind: flag, then persisted config, then default.
				const parsed = parseArgs(["serve", ...args]);
				const loaded = loadDaemonConfigResult(DEFAULT_CONFIG_DIR);
				if (loaded._tag === "Failure" && loaded.failure._tag !== "NotFound")
					throw loaded.failure;
				rpc = {
					port: parsed.portExplicit
						? parsed.port
						: loaded._tag === "Success"
							? loaded.success.port
							: DEFAULT_PORT,
					DEFAULT_SOCKET_PATH,
					isDaemonRunning,
					sendRpcRequest,
				};
			}
			if (stopping) return;
			lastBuildId = readBuildId();
			await restart();
			if (!stopping && !pending && !vite) await startVite();
			if (!stopping && !pending)
				log(`ready (${mode}${child ? ` PID ${child.pid}` : ""})`);
		}
	} while (pending && !stopping);
}

function runBuild() {
	if (stopping) return;
	if (activeBuild) {
		pending = true;
		return activeBuild;
	}
	activeBuild = rebuild()
		.catch(recover)
		.finally(() => {
			activeBuild = undefined;
		});
	return activeBuild;
}

/** Restart onto the current dist without rebuilding. */
function runRestart() {
	if (stopping || activeBuild || !rpc) return;
	activeBuild = restart()
		.then(async () => {
			if (stopping || pending) return;
			if (!vite) await startVite();
			if (!stopping && !pending)
				log(`ready (${mode}${child ? ` PID ${child.pid}` : ""})`);
		})
		.catch(recover)
		.finally(() => {
			activeBuild = undefined;
			if (pending && !stopping) runBuild();
		});
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
			if (
				filename === "vite.config.ts" ||
				filename === "tsconfig.json" ||
				filename === "tsconfig.build.json" ||
				filename === "package.json"
			)
				changed();
		}),
	);
	for (const watcher of watchers) watcher.on("error", fail);
	await runBuild();
	if (!stopping) {
		watchers.push(
			watch("dist", (_event, filename) => {
				if (filename !== "build-ready.json" || stopping || activeBuild) return;
				const buildId = readBuildId();
				if (!buildId || buildId === lastBuildId) return;
				lastBuildId = buildId;
				log(`external build ${buildId.slice(0, 8)} detected`);
				runRestart();
			}).on("error", fail),
		);
	}
	await stopped;
} catch (error) {
	fail(error);
} finally {
	stop();
	await activeBuild;
	await Promise.all([stopChild(), viteClosed]);
}
