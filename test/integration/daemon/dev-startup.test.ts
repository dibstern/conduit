// Failure cases: a removed config export, losing the persisted port, ignoring an
// explicit port, or starting with defaults after reading malformed config.
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
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";

it.each([
	"persisted",
	"explicit",
	"invalid",
] as const)("dev startup handles %s configuration", async (scenario) => {
	const root = mkdtempSync("/tmp/conduit-dev-startup-");
	const configDir = join(root, "config");
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
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("No port");
	const port = address.port;
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	writeFileSync(
		join(configDir, "daemon.json"),
		scenario === "invalid"
			? "{invalid json"
			: JSON.stringify({
					...defaultDaemonConfig(),
					port: scenario === "explicit" ? 1 : port,
				}),
	);
	const child = spawn(
		process.execPath,
		[
			"scripts/dev.mjs",
			...(scenario === "explicit" ? ["--port", String(port)] : []),
		],
		{
			cwd: root,
			env: {
				...process.env,
				HOME: join(root, "home"),
				CONDUIT_CONFIG_DIR: configDir,
				PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const closed = once(child, "close");
	let logs = "";
	child.stdout.on("data", (data: Buffer) => {
		logs += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		logs += data.toString();
	});
	try {
		await expect
			.poll(() => logs, { timeout: 20_000 })
			.toContain(
				scenario === "invalid" ? "waiting for the next change" : "[dev] ready",
			);
		expect(logs).not.toContain("is not a function");
		expect(child.exitCode).toBeNull();
		if (scenario === "invalid") {
			expect(logs).not.toContain("[dev] ready");
		} else {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			expect(response.ok).toBe(true);
			const viteReady = join(root, "vite-listening.json");
			await expect.poll(() => existsSync(viteReady)).toBe(true);
			const vite = JSON.parse(readFileSync(viteReady, "utf8")) as {
				port: number;
				clearScreen: boolean;
				logLevel: string;
			};
			const frontend = await fetch(`http://127.0.0.1:${vite.port}`);
			expect(await frontend.text()).toContain("Dev startup fixture");
			expect(logs).toContain("Conduit (foreground)");
			expect(logs).toContain("Vite warning probe");
			expect(logs).not.toMatch(/VITE v|ready in \d+ ms/);
			expect(vite.clearScreen).toBe(false);
			expect(vite.logLevel).toBe("warn");
		}
	} finally {
		child.kill("SIGINT");
		const [code] = await closed;
		mkdirSync("test-results/dev-startup", { recursive: true });
		writeFileSync(
			`test-results/dev-startup/${scenario}.json`,
			JSON.stringify({ scenario, port, exitCode: code, logs }, null, 2),
		);
		rmSync(root, { recursive: true, force: true });
		expect(code).toBe(0);
	}
}, 30_000);
