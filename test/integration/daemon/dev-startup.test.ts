// Failure cases: a removed config export, losing the persisted port, ignoring an
// explicit port, starting with defaults after reading malformed config, and a
// second dev:all that leaves the first running on its port (each respawns the
// server the other replaced) or hijacks another port's server.
import { spawn } from "node:child_process";
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
import { join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";
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
	/** Settles once the run has printed `text`. */
	const printed = (text: string) =>
		new Promise<void>((resolve) => {
			const check = () => logs.includes(text) && resolve();
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
