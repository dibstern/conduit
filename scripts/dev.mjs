// dev:all: rebuild on change, then restart the server onto the new build.
// Cycles run one at a time, and a newer change cuts the running one's waits
// short. Every stop is bounded (stopProcess), and a server is up only once it
// answers, so a server that cannot act on signals (a blocked event loop) costs
// a cycle the stop grace, never a hang.
import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
// Info logs drown dev:all's own lines; daemon.log keeps warnings either way.
// `pnpm dev:all -- --log-level info` (or the UI setting) brings them back.
const serveArgs = args.includes("--log-level")
	? args
	: ["--log-level", "warn", ...args];

/** How long a stopped process gets to exit before SIGKILL. */
const GRACE_MS = 10_000;
/** How long a server dev:all did not start gets to answer before it counts as wedged. */
const ANSWER_MS = 10_000;

const shutdown = new AbortController();
const stopped = new Promise((resolve) =>
	shutdown.signal.addEventListener("abort", resolve, { once: true }),
);
/** Every process group dev:all started that has not exited. */
const groups = new Set();
const watchers = [];
let timer;
let wake = () => {};
/** The next cycle: "build" builds, then restarts; "restart" only restarts. */
let queued = "build";
/** Aborts the running cycle's waits; undefined between cycles. */
let cycle;
let running;
let rpc;
let mode;
let builder;
let child;
let vite;
let lastBuildId;
const log = (message) => console.log(`[dev] ${message}`);

function stop() {
	if (shutdown.signal.aborted) return;
	shutdown.abort();
	clearTimeout(timer);
	for (const watcher of watchers) watcher.close();
	wake();
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

/** A second signal skips the graceful stop: everything dev:all started dies now. */
function onSignal() {
	if (!shutdown.signal.aborted) {
		log("stopping (Ctrl-C again kills everything now)");
		return stop();
	}
	for (const pid of groups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
	process.exit(130);
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
// Closing the terminal must not orphan the detached server on its port.
process.on("SIGHUP", onSignal);

/**
 * The one way dev:all stops a process: send `signal` (none only waits), give
 * it `graceMs` to exit, then SIGKILL it. A negative target is a process group,
 * as with process.kill. Resolves once the target is gone.
 */
async function stopProcess(target, signal, graceMs = GRACE_MS) {
	const pid = Math.abs(target);
	const gone = () => {
		try {
			process.kill(target, 0);
			return false;
		} catch (error) {
			// macOS answers EPERM for a group whose members are all zombies.
			if (error.code === "ESRCH" || (error.code === "EPERM" && target < 0))
				return true;
			throw error;
		}
	};
	if (signal) {
		try {
			process.kill(target, signal);
		} catch {}
	}
	const deadline = Date.now() + graceMs;
	let killed = false;
	while (!gone()) {
		if (!killed && Date.now() >= deadline) {
			killed = true;
			log(`PID ${pid} did not exit within ${graceMs / 1000}s; killing it`);
			try {
				process.kill(target, "SIGKILL");
			} catch {}
		}
		if (killed && Date.now() >= deadline + 5_000)
			throw new Error(`PID ${pid} survived SIGKILL`);
		await delay(100);
	}
}

/** Separate process groups let this script finish cleanup on terminal Ctrl-C. */
function launch(command, commandArgs, env = process.env) {
	const proc = spawn(command, commandArgs, {
		stdio: "inherit",
		detached: true,
		env,
	});
	if (proc.pid) {
		groups.add(proc.pid);
		proc.once("exit", () => groups.delete(proc.pid));
	}
	return proc;
}

function build() {
	log("building");
	const proc = launch("pnpm", ["build"]);
	builder = proc;
	return new Promise((resolve, reject) => {
		proc.once("error", reject);
		proc.once("close", (code) => resolve(code ?? 1));
	}).finally(() => {
		builder = undefined;
	});
}

async function stopChild() {
	const server = child;
	// Cleared first, so its exit reads as requested and is not restarted.
	child = undefined;
	if (server) await stopProcess(-server.pid, "SIGINT");
}

/** The server on this config dir: its PID, and its status if it answers within `timeoutMs`. */
async function probe(timeoutMs) {
	const pid = rpc.readDaemonBuild(rpc.socket)?.pid;
	if (pid === undefined) return undefined;
	const status = await rpc
		.sendRpcRequest(
			rpc.socket,
			{ _tag: "GetStatus" },
			{ requestTimeoutMs: timeoutMs, startupRetries: 0 },
		)
		.catch(() => undefined);
	return { pid, status };
}

/**
 * Waits until the server answering on this config dir satisfies `isUp`. A boot
 * on a big store can take minutes, so this has no deadline: it notes progress,
 * and a newer request or the shutdown ends it (undefined).
 */
async function waitUntilUp(label, isUp, signal, exited = () => false) {
	const started = Date.now();
	let noted = started;
	const aborted = new Promise((resolve) =>
		signal.addEventListener("abort", resolve, { once: true }),
	);
	while (!signal.aborted && !exited()) {
		const up = await Promise.race([probe(2_000), aborted]);
		if (up?.status && isUp(up)) return up;
		if (Date.now() - noted >= 15_000) {
			noted = Date.now();
			log(`${label} still starting (${Math.round((noted - started) / 1000)}s)`);
		}
		await delay(200, undefined, { signal }).catch(() => {});
	}
}

const commandOf = (pid) =>
	spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
		encoding: "utf8",
	}).stdout?.trim() ?? "";
const isConduitServer = (command) =>
	/\b(cli\.[jt]s|conduit)\s+serve\b/.test(command);

/** PIDs listening on the port; empty when there are none or lsof is missing. */
function portHolders(port) {
	const { stdout } = spawnSync(
		"lsof",
		["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
		{ encoding: "utf8" },
	);
	return (stdout ?? "").split("\n").filter(Boolean).map(Number);
}

/** Stops an old conduit server on another config dir that holds our port. */
async function freePort(port) {
	const holders = portHolders(port);
	for (const pid of holders) {
		const command = commandOf(pid);
		if (!isConduitServer(command)) {
			throw new Error(
				`port ${port} is held by PID ${pid} (${command || "unknown"}), which is not a conduit server; stop it and re-run`,
			);
		}
	}
	await Promise.all(
		holders.map((pid) => {
			log(`stopping old conduit PID ${pid} on port ${port}`);
			return stopProcess(pid, "SIGTERM");
		}),
	);
	const back = portHolders(port);
	if (back.length > 0) {
		throw new Error(
			`port ${port} is held again by PID ${back.join(", ")}; is it managed by a service on another config dir?`,
		);
	}
}

/**
 * Takes this port's dev:all lock and stops the run that held it: the same port
 * is the same service. Stopping only its server would get that respawned (and
 * ours killed in turn), so stop its supervisor, which stops its own server.
 * The lock is an open file, so it never outlives the run holding it.
 */
async function replaceOldRun(port) {
	const lock = join(tmpdir(), `conduit-dev-all-${port}.lock`);
	openSync(lock, "a");
	const { stdout } = spawnSync("lsof", ["-t", lock], { encoding: "utf8" });
	const old = (stdout ?? "")
		.split("\n")
		.filter(Boolean)
		.map(Number)
		.filter((pid) => pid !== process.pid);
	await Promise.all(
		old.map((pid) => {
			log(`stopping old dev:all PID ${pid} on port ${port}`);
			// Its own stop takes up to the grace, so it gets twice that.
			return stopProcess(pid, "SIGTERM", 2 * GRACE_MS);
		}),
	);
}

/** Loads what dev:all needs from the build, then replaces this port's old run. */
async function connect() {
	const [
		{ DEFAULT_CONFIG_DIR, DEFAULT_PORT, DEFAULT_SOCKET_PATH, parseArgs },
		{ loadDaemonConfigResult },
		{ readDaemonBuild },
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
	const port = parsed.portExplicit
		? parsed.port
		: loaded._tag === "Success"
			? loaded.success.port
			: DEFAULT_PORT;
	await replaceOldRun(port);
	// Set last: a check that throws above is retried on the next build.
	rpc = {
		configDir: DEFAULT_CONFIG_DIR,
		port,
		socket: DEFAULT_SOCKET_PATH,
		readDaemonBuild,
		sendRpcRequest,
	};
}

/**
 * Asks the service to exit for its supervisor to respawn. One still running
 * after the grace is SIGKILLed, which the supervisor also respawns; SIGTERM
 * would not do, since a clean exit stays stopped.
 */
async function restartService(pid, signal) {
	if (mode !== "service") log("dev:all is driving the conduit service");
	mode = "service";
	await rpc
		.sendRpcRequest(
			rpc.socket,
			{ _tag: "RestartWithConfig" },
			{ requestTimeoutMs: ANSWER_MS },
		)
		.catch((error) => log(`${error.message}; stopping PID ${pid}`));
	await stopProcess(pid);
	return waitUntilUp("conduit service", (up) => up.pid !== pid, signal);
}

/**
 * Replaces the server with one on the current build and returns it once it
 * answers. Undefined when the wait was cut short or dev:all refused to run.
 */
async function restart(signal) {
	log("restarting");
	await stopChild();
	if (shutdown.signal.aborted) return;
	const old = await probe(ANSWER_MS);
	if (shutdown.signal.aborted) return;
	// A config dir holds one server, so it cannot serve another port too.
	if (old?.status && old.status.port !== rpc.port) {
		fail(
			new Error(
				`conduit for ${rpc.configDir} already serves port ${old.status.port}; set CONDUIT_CONFIG_DIR to run another on port ${rpc.port}`,
			),
		);
		return;
	}
	if (old?.status?.supervised) return restartService(old.pid, signal);
	// Unsupervised, or not answering at all: an old server in ours' way.
	if (old && isConduitServer(commandOf(old.pid))) {
		log(
			`stopping old conduit PID ${old.pid}${old.status ? "" : " (not answering)"}`,
		);
		await stopProcess(old.pid, "SIGTERM");
	}
	await freePort(rpc.port);
	if (shutdown.signal.aborted) return;
	mode = "child";
	// A server dev:all spawns is not the service, even when dev:all runs in one.
	const server = launch(
		process.execPath,
		["dist/src/bin/cli.js", "serve", ...serveArgs],
		{ ...process.env, CONDUIT_SERVICE: undefined, XPC_SERVICE_NAME: undefined },
	);
	child = server;
	server.once("error", recover);
	server.once("exit", (code, exitSignal) => {
		if (child !== server) return;
		child = undefined;
		log(`server exited (${exitSignal ?? code}); restarting in 2s`);
		// Paced so a server that crashes on boot does not spin.
		setTimeout(() => request("restart"), 2_000);
	});
	return waitUntilUp(
		"server",
		(up) => up.pid === server.pid,
		signal,
		() => child !== server,
	);
}

/** Instant UI reload on top of whichever server dev:all drives. */
function startVite({ port, tlsEnabled }) {
	const server = `${tlsEnabled ? "https" : "http"}://localhost:${port}`;
	// Keep Conduit's startup screen visible while retaining Vite diagnostics.
	const proc = launch(
		process.execPath,
		[
			"node_modules/vite/bin/vite.js",
			"--clearScreen",
			"false",
			"--logLevel",
			"warn",
		],
		{ ...process.env, CONDUIT_DEV_SERVER: server },
	);
	proc.once("error", fail);
	return proc;
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

/**
 * A newer change cuts short the cycle's waits but not its build or stops: a
 * build always finishes, so a stream of edits still restarts the server.
 */
async function runCycle(kind, signal) {
	if (kind === "build") {
		const code = await build();
		if (shutdown.signal.aborted) return;
		if (code !== 0) return log("build failed; waiting for the next change");
	}
	if (!rpc) await connect();
	if (shutdown.signal.aborted) return;
	lastBuildId = readBuildId();
	const up = await restart(signal);
	if (!up || shutdown.signal.aborted) return;
	vite ??= startVite(up.status);
	log(`ready (${mode} PID ${up.pid})`);
}

/** Queues a cycle and cuts the running one's waits short. */
function request(kind) {
	if (shutdown.signal.aborted) return;
	queued = kind === "build" || queued === "build" ? "build" : "restart";
	cycle?.abort();
	wake();
}

async function loop() {
	while (!shutdown.signal.aborted) {
		if (!queued) {
			await new Promise((resolve) => {
				wake = resolve;
			});
			continue;
		}
		const kind = queued;
		queued = undefined;
		cycle = new AbortController();
		const signal = AbortSignal.any([cycle.signal, shutdown.signal]);
		running = runCycle(kind, signal).catch((error) => {
			if (!signal.aborted) recover(error);
		});
		await running;
		cycle = undefined;
	}
}

function changed() {
	clearTimeout(timer);
	timer = setTimeout(() => request("build"), 300);
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
	// A merge that moves a dependency changes package.json before `pnpm
	// install` runs, so that build fails against the old packages. An install
	// that changes node_modules rewrites .modules.yaml (a no-op one leaves it
	// alone), so build again then. Polled by path: a watch on node_modules
	// goes deaf once an install replaces the directory.
	const modulesStamp = () =>
		statSync("node_modules/.modules.yaml", { throwIfNoEntry: false })?.mtimeMs;
	let lastModulesStamp = modulesStamp();
	setInterval(() => {
		const stamp = modulesStamp();
		if (stamp === undefined || stamp === lastModulesStamp) return;
		lastModulesStamp = stamp;
		changed();
	}, 1_000).unref();
	// Polled, not watched: an external build (a pre-commit `pnpm build`) often
	// lands while dev:all is mid-cycle, and its one watch event was dropped,
	// leaving the server on the old build for good. Polling catches up after.
	setInterval(() => {
		if (cycle || !rpc) return;
		const buildId = readBuildId();
		if (!buildId || buildId === lastBuildId) return;
		lastBuildId = buildId;
		log(`external build ${buildId.slice(0, 8)} detected`);
		request("restart");
	}, 1_000).unref();
	await Promise.race([loop(), stopped]);
} catch (error) {
	fail(error);
} finally {
	stop();
	await Promise.all([
		builder && stopProcess(-builder.pid, "SIGTERM"),
		stopChild(),
		// Vite closes its own esbuild helper; signalling its group makes that crash.
		vite && stopProcess(vite.pid, "SIGTERM"),
		running,
	]).catch(fail);
	// A request still in flight to a wedged server would hold the loop open.
	process.exit();
}
