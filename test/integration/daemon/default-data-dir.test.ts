import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GetProjects, GetStatus } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";

// Failure cases: first startup chooses the wrong directory, explicit XDG loses,
// legacy projects disappear, startup writes to an inactive directory, or the
// foreground child survives cleanup. Each run leaves normalized JSON evidence.
const dist = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const cases = [
	{ name: "config-home", expected: ".config/conduit" },
	{ name: "no-config-home", expected: ".conduit" },
	{ name: "legacy-project", expected: ".conduit" },
	{ name: "explicit-xdg", expected: "xdg/conduit" },
] as const;
const results = cases.map(({ name }) => ({
	case: name,
	resolvedDir: null as string | null,
	seededProjectReachable: null as boolean | null,
	passed: false,
}));

describe("built daemon default data directory", () => {
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn22-data-dir.json",
			`${JSON.stringify(results, null, 2)}\n`,
		);
	});

	it.each(cases)("$name", async ({ name, expected }) => {
		// Keep Unix socket paths below macOS's limit, including under TMPDIR.
		const home = realpathSync(mkdtempSync("/tmp/cdt-dir-"));
		const result = results.find((entry) => entry.case === name);
		if (!result) throw new Error("Missing scenario result");
		let child: ReturnType<typeof spawn> | undefined;
		let exited: Promise<unknown> | undefined;
		let output = "";
		let spawnError: Error | undefined;
		try {
			expect(existsSync(join(dist, "src/bin/cli.js"))).toBe(true);
			if (name !== "no-config-home") mkdirSync(join(home, ".config"));
			const project = join(home, "seeded-project");
			if (name === "legacy-project") {
				result.seededProjectReachable = false;
				mkdirSync(project);
				mkdirSync(join(home, ".conduit"));
				writeFileSync(
					join(home, ".conduit/daemon.json"),
					JSON.stringify({
						pid: 0,
						port: 2633,
						pinHash: null,
						tls: false,
						debug: false,
						keepAwake: false,
						projects: [
							{
								path: project,
								folders: [project],
								slug: "seeded-project",
								addedAt: 0,
							},
						],
					}),
				);
			}
			if (name === "explicit-xdg") {
				mkdirSync(join(home, ".config/conduit"));
				mkdirSync(join(home, ".conduit"));
			}
			const candidates = [".config/conduit", ".conduit", "xdg/conduit"];
			const inactive = candidates
				.filter((directory) => directory !== expected)
				.map((directory) => ({
					directory,
					contents: existsSync(join(home, directory))
						? readdirSync(join(home, directory)).sort()
						: null,
				}));

			// The CLI rejects --port 0, so reserve a free port as the harness does.
			const port = await new Promise<number>((done, fail) => {
				const server = createServer();
				server.once("error", fail);
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					if (!address || typeof address === "string") {
						server.close(() => fail(new Error("No isolated daemon port")));
						return;
					}
					server.close(() => done(address.port));
				});
			});
			// Use the harness's fake SDK and suppress real capability probes.
			const require = createRequire(import.meta.url);
			const preload = join(home, "cli-fixture.mjs");
			writeFileSync(
				preload,
				`import { Effect } from ${JSON.stringify(pathToFileURL(require.resolve("effect")).href)};
import { ClaudeDriver } from ${JSON.stringify(pathToFileURL(join(dist, "src/lib/provider/claude/claude-provider-instance.js")).href)};
const create = ClaudeDriver.create;
Object.assign(ClaudeDriver, { create: deps => create({ ...deps,
  capabilitiesService: { get: () => Effect.succeed({ models: [], agents: [], commands: [] }) }
}) });
`,
			);
			const env: NodeJS.ProcessEnv = {
				PATH: process.env["PATH"],
				HOME: home,
				SHELL: "/bin/sh",
				NODE_ENV: "test",
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
				XDG_CACHE_HOME: join(home, "cache"),
				XDG_DATA_HOME: join(home, "data"),
				CONDUIT_TEST_CLAUDE_QUERY_MODULE: pathToFileURL(
					fileURLToPath(
						new URL(
							"../../helpers/fake-claude-process-sdk.ts",
							import.meta.url,
						),
					),
				).href,
				...(name === "explicit-xdg"
					? { XDG_CONFIG_HOME: join(home, "xdg") }
					: {}),
			};
			child = spawn(
				process.execPath,
				[
					"--import",
					pathToFileURL(require.resolve("tsx")).href,
					"--import",
					pathToFileURL(preload).href,
					join(dist, "src/bin/cli.js"),
					"serve",
					"--port",
					String(port),
					"--host",
					"127.0.0.1",
					"--no-https",
					"--no-tailscale-serve",
				],
				{ cwd: home, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
			);
			child.on("error", (error) => {
				spawnError = error;
			});
			exited = new Promise((done) => child?.once("close", done));
			for (const stream of [child.stdout, child.stderr])
				stream?.on("data", (chunk: Buffer) => {
					output = (output + chunk.toString()).slice(-8000);
				});

			let configDir = "";
			await vi.waitFor(
				() => {
					if (spawnError) throw spawnError;
					if (child?.exitCode !== null || child?.signalCode !== null)
						throw new Error(`Daemon exited before readiness:\n${output}`);
					configDir =
						candidates
							.map((directory) => join(home, directory))
							.find((directory) => existsSync(join(directory, "relay.sock"))) ??
						"";
					expect(configDir, output).not.toBe("");
					expect(existsSync(join(configDir, "daemon.json")), output).toBe(true);
				},
				{ timeout: 20_000, interval: 50 },
			);
			result.resolvedDir = `~/${relative(home, configDir).split("\\").join("/")}`;
			expect(result.resolvedDir).toBe(`~/${expected}`);
			const socket = join(configDir, "relay.sock");
			const status = await sendRpcRequest(socket, new GetStatus({}));
			expect(status.port).toBe(port);
			if (name === "legacy-project") {
				const { projects } = await sendRpcRequest(socket, new GetProjects({}));
				result.seededProjectReachable = projects.some(
					(entry) =>
						entry.slug === "seeded-project" && entry.folders.includes(project),
				);
				expect(result.seededProjectReachable).toBe(true);
			}
			for (const { directory, contents } of inactive)
				expect(
					existsSync(join(home, directory))
						? readdirSync(join(home, directory)).sort()
						: null,
				).toEqual(contents);
			result.passed = true;
		} finally {
			let cleanupPassed = false;
			try {
				if (child && exited) {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGTERM");
						try {
							await vi.waitFor(() => expect(child?.exitCode).toBe(0), {
								timeout: 5000,
							});
						} finally {
							if (child.exitCode === null && child.signalCode === null)
								child.kill("SIGKILL");
							await exited;
						}
					}
					expect(child.exitCode, output).toBe(0);
				}
				cleanupPassed = true;
			} finally {
				result.passed &&= cleanupPassed;
				rmSync(home, { recursive: true, force: true });
			}
		}
	}, 45_000);
});
