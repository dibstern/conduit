// Failure cases: a removed config export, losing the persisted port, ignoring an
// explicit port, starting with defaults after reading malformed config, a
// second dev:all that leaves the first running on its port (each respawns the
// server the other replaced) or hijacks another port's server, and a server
// that cannot act on signals (a blocked event loop) wedging a restart, a
// takeover or Ctrl-C.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
	generateServiceUnit,
	getServicePaths,
} from "../../../src/bin/cli-service.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";

/** A checkout with the real script and build, where `pnpm build` is a no-op. */
function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "conduit-dev-startup-"));
	for (const dir of ["bin", "scripts", "src", "config", "home"])
		mkdirSync(join(root, dir));
	copyFileSync("scripts/dev.mjs", join(root, "scripts/dev.mjs"));
	symlinkSync(
		resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
		join(root, "dist"),
	);
	symlinkSync(resolve("node_modules"), join(root, "node_modules"));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(join(root, "index.html"), "<h1>Dev startup fixture</h1>");
	writeFileSync(
		join(root, "vite.config.mjs"),
		`import { writeFileSync } from "node:fs";
export default {
	cacheDir: ".vite",
	server: { host: "127.0.0.1", port: 0 },
	plugins: [{
		name: "startup-proof",
		configureServer(server) {
			server.httpServer.once("listening", () => {
				writeFileSync("vite-listening.json", JSON.stringify({
					port: server.httpServer.address().port,
					clearScreen: server.config.clearScreen,
					logLevel: server.config.logLevel,
				}));
				server.config.logger.warn("Vite warning probe");
			});
		},
	}],
};
`,
	);
	// Reuse a real compiled build; this test exercises the dev process through
	// actual config loading and server readiness, without rebuilding per case.
	writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\nexit 0\n", {
		mode: 0o755,
	});
	return root;
}

/** Distinct free ports, all held until every one is chosen. */
async function reservePorts(count: number): Promise<number[]> {
	const servers = Array.from({ length: count }, () =>
		createServer().listen(0, "127.0.0.1"),
	);
	await Promise.all(servers.map((server) => once(server, "listening")));
	const ports = servers.map((server) => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		return address.port;
	});
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		),
	);
	return ports;
}

function startDev(root: string, configDir: string, args: string[]) {
	const child = spawn(process.execPath, ["scripts/dev.mjs", ...args], {
		cwd: root,
		env: {
			...process.env,
			HOME: join(root, "home"),
			CONDUIT_CONFIG_DIR: configDir,
			// The service lookup finds its unit here, never the host's.
			XDG_CONFIG_HOME: join(root, "home", ".config"),
			CONDUIT_SERVICE_LABEL: undefined,
			PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	let logs = "";
	child.stdout.on("data", (data: Buffer) => {
		logs += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		logs += data.toString();
	});
	/** Settles once the run has printed `text` at or after offset `from` of its logs. */
	const printed = (text: string, from = 0) =>
		new Promise<void>((resolve) => {
			const check = () => logs.includes(text, from) && resolve();
			check();
			child.stdout.on("data", check);
			child.stderr.on("data", check);
		});
	return { child, closed, logs: () => logs, printed };
}

it.each([
	"persisted",
	"explicit",
	"invalid",
] as const)("dev startup handles %s configuration", async (scenario) => {
	const root = makeRoot();
	const configDir = join(root, "config");
	// This fixture owns its child; host listeners are never cleanup targets.
	writeFileSync(join(root, "bin/lsof"), "#!/bin/sh\nexit 1\n", {
		mode: 0o755,
	});
	const [port = 0] = await reservePorts(1);
	writeFileSync(
		join(configDir, "daemon.json"),
		scenario === "invalid"
			? "{invalid json"
			: JSON.stringify({
					...defaultDaemonConfig(),
					port: scenario === "explicit" ? 1 : port,
				}),
	);
	const { child, closed, logs } = startDev(
		root,
		configDir,
		scenario === "explicit" ? ["--port", String(port)] : [],
	);
	const viteReady = join(root, "vite-listening.json");
	try {
		await expect
			.poll(
				() => ({
					ready: logs().includes(
						scenario === "invalid"
							? "waiting for the next change"
							: "[dev] ready",
					),
					vite: scenario === "invalid" || existsSync(viteReady),
				}),
				{ timeout: 20_000 },
			)
			.toEqual({ ready: true, vite: true });
		expect(logs()).not.toContain("is not a function");
		expect(logs()).not.toContain("stopping old conduit");
		expect(child.exitCode).toBeNull();
		if (scenario === "invalid") {
			expect(logs()).not.toContain("[dev] ready");
		} else {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			expect(response.ok).toBe(true);
			const vite = JSON.parse(readFileSync(viteReady, "utf8")) as {
				port: number;
				clearScreen: boolean;
				logLevel: string;
			};
			const frontend = await fetch(`http://127.0.0.1:${vite.port}`);
			expect(await frontend.text()).toContain("Dev startup fixture");
			expect(logs()).toContain("Conduit (foreground)");
			expect(logs()).toContain("Vite warning probe");
			expect(logs()).not.toMatch(/VITE v|ready in \d+ ms/);
			expect(vite.clearScreen).toBe(false);
			expect(vite.logLevel).toBe("warn");
		}
	} finally {
		child.kill("SIGINT");
		const [code] = await closed;
		mkdirSync("test-results/dev-startup", { recursive: true });
		writeFileSync(
			`test-results/dev-startup/${scenario}.json`,
			JSON.stringify({ scenario, port, exitCode: code, logs: logs() }, null, 2),
		);
		rmSync(root, { recursive: true, force: true });
		expect(code).toBe(0);
	}
}, 30_000);

// The same port is the same service, so a new run replaces the old one. A config
// dir holds one server, so a run on another port needs its own config dir.
it.each([
	{ config: "same", port: "same", expected: "takeover" },
	{ config: "other", port: "same", expected: "takeover" },
	{ config: "same", port: "other", expected: "refuse" },
	{ config: "other", port: "other", expected: "coexist" },
] as const)("a second dev:all on the $config config and $port port: $expected", async ({
	config,
	port,
	expected,
}) => {
	const root = makeRoot();
	const [portA = 0, portB = 0] = await reservePorts(2);
	const configA = join(root, "config");
	const configB = config === "same" ? configA : join(root, "config-b");
	const servedB = port === "same" ? portA : portB;
	mkdirSync(configB, { recursive: true });
	// A shared config keeps A's port; B then names its own.
	for (const [dir, served] of [
		[configB, servedB],
		[configA, portA],
	] as const) {
		writeFileSync(
			join(dir, "daemon.json"),
			JSON.stringify({ ...defaultDaemonConfig(), port: served }),
		);
	}
	const a = startDev(root, configA, []);
	const runs = [a];
	// Runs even when a hung wait times the test out, so no run outlives it.
	onTestFinished(async () => {
		for (const run of runs) {
			if (run.child.exitCode === null) run.child.kill("SIGINT");
			await run.closed;
		}
		mkdirSync("test-results/dev-startup", { recursive: true });
		writeFileSync(
			`test-results/dev-startup/second-run-${config}-config-${port}-port.json`,
			JSON.stringify(
				{ expected, portA, portB, a: a.logs(), b: runs[1]?.logs() },
				null,
				2,
			),
		);
		rmSync(root, { recursive: true, force: true });
	});
	await a.printed("[dev] ready");
	// Only the same config on another port has to name its port.
	const b = startDev(
		root,
		configB,
		config === "same" && port === "other" ? ["--port", String(portB)] : [],
	);
	runs.push(b);
	await (expected === "refuse" ? b.closed : b.printed("[dev] ready"));
	expect(b.logs()).not.toContain("driving the conduit service");
	if (expected === "takeover") {
		const [code] = await a.closed;
		expect(code).toBe(0);
	} else {
		expect(a.child.exitCode).toBeNull();
	}
	if (expected === "refuse") {
		expect(b.child.exitCode).toBe(1);
		expect(b.logs()).toContain("CONDUIT_CONFIG_DIR");
	} else {
		expect(b.child.exitCode).toBeNull();
	}
	const served = expected === "coexist" ? [portA, portB] : [portA];
	for (const servedPort of served) {
		const response = await fetch(`http://127.0.0.1:${servedPort}/health`);
		expect(response.ok).toBe(true);
	}
});

/** Rejects once `ms` pass, so a wedged wait fails as itself, not as a test timeout. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			// test-waits-allow real-wait: a deadline on an awaited condition, not a sleep.
			setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms),
		),
	]);
}

const readyPid = (logs: string) =>
	Number(
		[...logs.matchAll(/\[dev\] ready \(child PID (\d+)\)/g)].at(-1)?.[1] ??
			Number.NaN,
	);

const isGone = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};

/**
 * One dev:all on its own port and config. `freeze` SIGSTOPs a server, which
 * then acts on no signal but SIGKILL, as when its event loop is blocked.
 */
async function frozenFixture(name: string) {
	const root = makeRoot();
	const configDir = join(root, "config");
	const [port = 0] = await reservePorts(1);
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({ ...defaultDaemonConfig(), port }),
	);
	const runs: ReturnType<typeof startDev>[] = [];
	const frozen: number[] = [];
	const started = Date.now();
	onTestFinished(async () => {
		for (const pid of frozen) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await Promise.all(
			runs.map(async (run) => {
				if (run.child.exitCode === null && run.child.signalCode === null)
					run.child.kill("SIGINT");
				await within(20_000, run.closed).catch(() => run.child.kill("SIGKILL"));
			}),
		);
		mkdirSync("test-results/dev-startup", { recursive: true });
		writeFileSync(
			`test-results/dev-startup/frozen-${name}.json`,
			JSON.stringify(
				{
					name,
					port,
					frozen,
					seconds: (Date.now() - started) / 1000,
					runs: runs.map((run) => run.logs()),
				},
				null,
				2,
			),
		);
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		port,
		start: () => {
			const run = startDev(root, configDir, []);
			runs.push(run);
			return run;
		},
		freeze: (pid: number) => {
			frozen.push(pid);
			process.kill(pid, "SIGSTOP");
		},
	};
}

it("a restart replaces a server that cannot act on signals", async () => {
	const fixture = await frozenFixture("restart");
	const run = fixture.start();
	await within(10_000, run.printed("[dev] ready"));
	const old = readyPid(run.logs());
	const restarted = run.printed("[dev] ready", run.logs().length);
	fixture.freeze(old);
	writeFileSync(join(fixture.root, "src/changed.ts"), "export {};\n");
	// The stop grace, a force-kill and a boot.
	await within(20_000, restarted);
	expect(readyPid(run.logs())).not.toBe(old);
	expect(isGone(old)).toBe(true);
	const response = await fetch(`http://127.0.0.1:${fixture.port}/health`);
	expect(response.ok).toBe(true);
});

it.each([
	"ready",
	"booting",
] as const)("a second dev:all takes over from a run whose server froze while %s", async (when) => {
	const fixture = await frozenFixture(`takeover-${when}`);
	const a = fixture.start();
	let old = Number.NaN;
	if (when === "ready") {
		await within(10_000, a.printed("[dev] ready"));
		old = readyPid(a.logs());
	} else {
		// Freeze the server as soon as it spawns, before it answers anything.
		// test-waits-allow polling: nothing announces the spawn, and the freeze needs its PID.
		await expect
			.poll(
				() => {
					const { stdout } = spawnSync(
						"pgrep",
						["-P", String(a.child.pid), "-f", "cli.js serve"],
						{ encoding: "utf8" },
					);
					old = Number(stdout.trim().split("\n")[0] || Number.NaN);
					return Number.isNaN(old);
				},
				{ timeout: 10_000, interval: 20 },
			)
			.toBe(false);
	}
	fixture.freeze(old);
	const b = fixture.start();
	// The old run's stop grace, a force-kill and a boot.
	await within(20_000, b.printed("[dev] ready"));
	const [code] = await within(5_000, a.closed);
	expect(code).toBe(0);
	expect(isGone(old)).toBe(true);
	expect(b.child.exitCode).toBeNull();
	const response = await fetch(`http://127.0.0.1:${fixture.port}/health`);
	expect(response.ok).toBe(true);
});

it.each([
	{ presses: 1, bound: 15_000, exitCode: 0 },
	{ presses: 2, bound: 3_000, exitCode: 130 },
])("$presses Ctrl-C ends dev:all within $bound ms though its server cannot act on signals", async ({
	presses,
	bound,
	exitCode,
}) => {
	const fixture = await frozenFixture(`ctrl-c-${presses}`);
	const run = fixture.start();
	await within(10_000, run.printed("[dev] ready"));
	const old = readyPid(run.logs());
	fixture.freeze(old);
	run.child.kill("SIGINT");
	if (presses === 2) {
		// The second press lands once the first is being handled.
		await within(5_000, run.printed("[dev] stopping ("));
		run.child.kill("SIGINT");
	}
	const [code] = await within(bound, run.closed);
	expect(code).toBe(exitCode);
	expect(isGone(old)).toBe(true);
});

// Each run replaces the runs that took the lock before it. Two runs started
// together used to take each other for the old run, wait out each other's
// stop and kill each other, so neither was left.
it("two dev:all started together leave exactly one running", async () => {
	const fixture = await frozenFixture("together");
	const runs = [fixture.start(), fixture.start()] as const;
	const replaced = await within(
		20_000,
		Promise.race(
			runs.map((run) => run.closed.then(([code]) => ({ run, code }))),
		),
	);
	expect(replaced.code).toBe(0);
	const kept = runs[replaced.run === runs[0] ? 1 : 0];
	await within(10_000, kept.printed("[dev] ready"));
	expect(kept.child.exitCode).toBeNull();
	const response = await fetch(`http://127.0.0.1:${fixture.port}/health`);
	expect(response.ok).toBe(true);
});

/**
 * A service its supervisor runs on the config dir: `launchctl` and `systemctl`
 * report its PID, and it is respawned whenever it dies, as KeepAlive and
 * Restart=on-failure respawn a killed one.
 */
function supervise(root: string, configDir: string) {
	const home = join(root, "home");
	const paths = getServicePaths(
		process.platform,
		home,
		configDir,
		root,
		join(home, ".config"),
	);
	mkdirSync(dirname(paths.unitFile), { recursive: true });
	writeFileSync(
		paths.unitFile,
		generateServiceUnit({
			platform: process.platform,
			shell: "/bin/sh",
			command: ["conduit", "serve"],
			paths,
		}),
	);
	const pidFile = join(root, "service.pid");
	for (const [name, report] of [
		["launchctl", "pid = %s\\n"],
		["systemctl", "LoadState=loaded\\nMainPID=%s\\n"],
	] as const) {
		writeFileSync(
			join(root, "bin", name),
			`#!/bin/sh\nprintf '${report}' "$(cat '${pidFile}')"\n`,
			{ mode: 0o755 },
		);
	}
	const services: ChildProcess[] = [];
	let supervising = true;
	const respawn = () => {
		const service = spawn(
			process.execPath,
			["dist/src/bin/cli.js", "serve", "--log-level", "warn"],
			{
				cwd: root,
				env: {
					...process.env,
					HOME: home,
					CONDUIT_CONFIG_DIR: configDir,
					CONDUIT_SERVICE: "1",
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		services.push(service);
		writeFileSync(pidFile, String(service.pid));
		service.once("exit", () => supervising && respawn());
		let output = "";
		return new Promise<number>((resolve) =>
			service.stdout?.on("data", (data: Buffer) => {
				output += data.toString();
				if (output.includes("Ready.")) resolve(Number(service.pid));
			}),
		);
	};
	onTestFinished(() => {
		supervising = false;
		for (const service of services) service.kill("SIGKILL");
	});
	return { started: respawn(), current: () => services.at(-1)?.pid };
}

// A wedged service cannot say it is supervised. Stopped like any old server, its
// supervisor respawned it into a race with the server dev:all started in its place.
it("dev:all restarts a wedged service through its supervisor, never racing it", async () => {
	const fixture = await frozenFixture("service");
	const service = supervise(fixture.root, join(fixture.root, "config"));
	const old = await within(10_000, service.started);
	fixture.freeze(old);
	const run = fixture.start();
	// No answer within 10s, a kill, and the respawned service's boot.
	await within(20_000, run.printed("[dev] ready ("));
	expect(run.logs()).toContain(
		`[dev] ready (service PID ${service.current()})`,
	);
	expect(run.logs()).not.toContain("stopping old conduit");
	expect(isGone(old)).toBe(true);
});
