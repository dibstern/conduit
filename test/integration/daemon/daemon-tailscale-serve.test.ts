// Failure cases: missing CLI, logged-out backend, disabled certificates, missing
// DNS name, malformed JSON, foreign root handlers, and failed Serve commands.
// Every daemon uses an isolated config directory and a fake Tailscale binary.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { parseArgs } from "../../../src/bin/cli-utils.js";
import { GetStatus } from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { DaemonOptions } from "../../../src/lib/daemon/daemon-types.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";

const dnsName = "conduit-test.example.ts.net";
const fakeScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.jsonl"), JSON.stringify(args) + "\\n");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
if (JSON.stringify(args) === JSON.stringify(["status", "--json"])) {
  process.stdout.write(read("status.json"));
} else if (JSON.stringify(args) === JSON.stringify(["serve", "status", "--json"])) {
  process.stdout.write(read("serve.json"));
} else {
  if (fs.existsSync(path.join(dir, "fail-serve"))) {
    process.stderr.write("permission denied by fake Tailscale");
    process.exit(1);
  }
  const config = JSON.parse(read("serve.json"));
  const dns = JSON.parse(read("status.json")).Self.DNSName.replace(/\\.$/, "");
  const web = config.Web ??= {};
  const https = args.find(arg => arg.startsWith("--https="));
  const port = https?.slice("--https=".length);
  const server = web[dns + ":" + port] ??= { Handlers: {} };
  if (args.length === 5 && args.slice(0, 4).join(" ") === "serve --bg " + https + " --set-path=/") {
    server.Handlers["/"] = { Proxy: args[4] };
  } else if (args.join(" ") === "serve " + https + " --set-path=/ off") {
    delete server.Handlers["/"];
  } else {
    process.stderr.write("unexpected fake Tailscale command: " + JSON.stringify(args));
    process.exit(2);
  }
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(config));
}
`;

describe("daemon Tailscale Serve", () => {
	let root: string;
	let configDir: string;
	let staticDir: string;
	let binary: string;
	let daemons: ForegroundDaemonHandle[];

	const writeJson = (name: string, value: unknown) =>
		writeFileSync(join(root, name), JSON.stringify(value));
	const invocations = (): string[][] => {
		const file = join(root, "argv.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	};
	const otherHandlers = (port?: number) => ({
		Web: {
			[`${dnsName}:443`]: {
				Handlers: {
					"/": { Proxy: `http://127.0.0.1:${port ?? 9000}` },
					"/composer-designs": { Proxy: "http://127.0.0.1:9002" },
				},
			},
			[`${dnsName}:8443`]: {
				Handlers: { "/": { Proxy: "http://127.0.0.1:9001" } },
			},
			...(port !== undefined && {
				[`${dnsName}:${port}`]: {
					Handlers: { "/composer-designs": { Proxy: "http://127.0.0.1:9003" } },
				},
			}),
		},
	});
	const start = async (options: DaemonOptions = {}) => {
		const daemon = await startForegroundDaemon({
			configDir,
			staticDir,
			smartDefault: false,
			tlsEnabled: false,
			...options,
		});
		daemons.push(daemon);
		return daemon;
	};
	const expectHttp = async (daemon: ForegroundDaemonHandle) => {
		expect(daemon.getStatus()).toMatchObject({
			host: "127.0.0.1",
			tlsEnabled: false,
		});
		expect(daemon.onboardingPort).toBeNull();
		const response = await fetch(`http://127.0.0.1:${daemon.port}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			tlsEnabled: false,
		});
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ts-serve-"));
		configDir = join(root, "config");
		staticDir = join(root, "static");
		mkdirSync(staticDir);
		writeFileSync(join(staticDir, "index.html"), "<html>Conduit</html>");
		binary = join(root, "tailscale.cjs");
		writeFileSync(binary, fakeScript, { mode: 0o755 });
		vi.stubEnv("CONDUIT_TAILSCALE_BIN", binary);
		writeJson("status.json", {
			BackendState: "Running",
			Self: { DNSName: `${dnsName}.` },
			CertDomains: [dnsName],
		});
		writeJson("serve.json", otherHandlers());
		daemons = [];
	});

	afterEach(async () => {
		for (const daemon of daemons) await daemon.stop();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("claims only / on the actual bound port and keeps HTTP on loopback", async () => {
		const initial = await start({ port: 0 });
		await initial.stop();
		writeJson("serve.json", otherHandlers(initial.port));
		const daemon = await start({
			tailscaleServe: true,
			tlsEnabled: true,
		});
		await expectHttp(daemon);
		expect(daemon.port).toBeGreaterThan(0);
		await expect(
			fetch(`http://127.0.0.2:${daemon.port}/health`, {
				signal: AbortSignal.timeout(1000),
			}),
		).rejects.toThrow();
		expect(invocations()).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
			[
				"serve",
				"--bg",
				`--https=${daemon.port}`,
				"--set-path=/",
				`http://127.0.0.1:${daemon.port}`,
			],
		]);
		const url = `https://${dnsName}:${daemon.port}`;
		expect(daemon.getStatus().tailscaleServe).toEqual({ url });
		const status = await sendRpcRequest(
			join(configDir, "relay.sock"),
			new GetStatus({}),
		);
		expect(status.tailscaleServe).toEqual({ url });
		expect(JSON.parse(readFileSync(join(root, "serve.json"), "utf8"))).toEqual({
			Web: {
				...otherHandlers(daemon.port).Web,
				[`${dnsName}:${daemon.port}`]: {
					Handlers: {
						"/composer-designs": { Proxy: "http://127.0.0.1:9003" },
						"/": { Proxy: `http://127.0.0.1:${daemon.port}` },
					},
				},
			},
		});
		expect(existsSync(join(configDir, "certs"))).toBe(false);
	});

	it("persists the mode, leaves the mapping on shutdown, and makes no mutation when / is already ours", async () => {
		const first = await start({ port: 0, tailscaleServe: true });
		await first.stop();
		expect(loadDaemonConfig(configDir)).toMatchObject({
			tailscaleServe: true,
			tls: false,
			port: first.port,
		});
		const beforeRestart = invocations();
		expect(beforeRestart).toHaveLength(3);
		const restarted = await start({ tlsEnabled: true });
		await expectHttp(restarted);
		expect(restarted.getStatus().tailscaleServe).toEqual({
			url: `https://${dnsName}:${restarted.port}`,
		});
		expect(invocations().slice(beforeRestart.length)).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
		]);
	});

	it("claims / when Serve has no existing Web configuration", async () => {
		writeJson("serve.json", {});
		const daemon = await start({ port: 0, tailscaleServe: true });
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			url: `https://${dnsName}:${daemon.port}`,
		});
		expect(invocations().at(-1)).toEqual([
			"serve",
			"--bg",
			`--https=${daemon.port}`,
			"--set-path=/",
			`http://127.0.0.1:${daemon.port}`,
		]);
	});

	it.each([
		{ Proxy: "http://127.0.0.1:9999" },
		{ Path: "/a/foreign/directory" },
	])("preserves a foreign / handler on the bound port (%j) and reports a conflict without stopping HTTP", async (handler) => {
		const initial = await start({ port: 0 });
		await initial.stop();
		const foreign = {
			Web: {
				...otherHandlers().Web,
				[`${dnsName}:${initial.port}`]: { Handlers: { "/": handler } },
			},
		};
		writeJson("serve.json", foreign);
		const daemon = await start({
			tailscaleServe: true,
			tlsEnabled: true,
		});
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			error: expect.stringContaining(
				`conflict: '/' on ${dnsName}:${daemon.port}`,
			),
		});
		expect(invocations()).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
		]);
		expect(JSON.parse(readFileSync(join(root, "serve.json"), "utf8"))).toEqual(
			foreign,
		);
	});

	it.each([
		[
			{
				BackendState: "NeedsLogin",
				Self: { DNSName: `${dnsName}.` },
				CertDomains: [dnsName],
			},
			/running.*sign in/i,
		],
		[
			{
				BackendState: "Running",
				Self: { DNSName: `${dnsName}.` },
				CertDomains: [],
			},
			/certificates.*DNS/i,
		],
		[
			{
				BackendState: "Running",
				Self: { DNSName: "" },
				CertDomains: [dnsName],
			},
			/DNSName.*MagicDNS/i,
		],
	])("reports an unavailable Tailscale prerequisite and keeps serving HTTP (%j)", async (status, error) => {
		writeJson("status.json", status);
		const daemon = await start({
			port: 0,
			tailscaleServe: true,
			tlsEnabled: true,
		});
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			error: expect.stringMatching(error),
		});
		expect(invocations()).toEqual([["status", "--json"]]);
	});

	it("reports a missing binary without falling back to the real binary or TLS", async () => {
		vi.stubEnv("CONDUIT_TAILSCALE_BIN", join(root, "missing-tailscale"));
		const daemon = await start({
			port: 0,
			tailscaleServe: true,
			tlsEnabled: true,
		});
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			error: expect.stringMatching(/install Tailscale.*CONDUIT_TAILSCALE_BIN/i),
		});
		expect(invocations()).toEqual([]);
	});

	it("reports malformed Serve status without making any mutation", async () => {
		writeFileSync(join(root, "serve.json"), "{bad json");
		const daemon = await start({ port: 0, tailscaleServe: true });
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			error: expect.stringMatching(/status.*JSON/i),
		});
		expect(invocations()).toHaveLength(2);
	});

	it("reports a failed Serve command while keeping HTTP available", async () => {
		writeFileSync(join(root, "fail-serve"), "");
		const daemon = await start({ port: 0, tailscaleServe: true });
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toEqual({
			error: expect.stringMatching(/permission denied.*restart/i),
		});
		expect(invocations()).toHaveLength(3);
	});

	it("--no-tailscale-serve removes only our / on the bound port and persists the disabled choice", async () => {
		const initial = await start({ port: 0 });
		await initial.stop();
		writeJson("serve.json", otherHandlers(initial.port));
		const first = await start({ tailscaleServe: true });
		await first.stop();
		const beforeDisable = invocations().length;
		const args = parseArgs(["serve", "--no-tailscale-serve", "--no-https"]);
		assert(args.tailscaleServe === false);
		const disabled = await start({ tailscaleServe: args.tailscaleServe });
		await expectHttp(disabled);
		expect(disabled.getStatus().tailscaleServe).toBeUndefined();
		expect(invocations().slice(beforeDisable)).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
			["serve", `--https=${disabled.port}`, "--set-path=/", "off"],
		]);
		expect(JSON.parse(readFileSync(join(root, "serve.json"), "utf8"))).toEqual(
			otherHandlers(disabled.port),
		);
		await disabled.stop();
		expect(loadDaemonConfig(configDir)?.tailscaleServe).toBe(false);
		const beforeOffRestart = invocations().length;
		const restarted = await start();
		expect(restarted.getStatus().tailscaleServe).toBeUndefined();
		expect(invocations()).toHaveLength(beforeOffRestart);
	});

	it("disabling preserves a foreign / handler", async () => {
		const first = await start({ port: 0, tailscaleServe: true });
		await first.stop();
		const foreign = {
			Web: {
				...otherHandlers().Web,
				[`${dnsName}:${first.port}`]: {
					Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
				},
			},
		};
		writeJson("serve.json", foreign);
		const beforeDisable = invocations().length;
		const disabled = await start({ tailscaleServe: false });
		await expectHttp(disabled);
		expect(disabled.getStatus().tailscaleServe).toBeUndefined();
		expect(invocations().slice(beforeDisable)).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
		]);
		expect(JSON.parse(readFileSync(join(root, "serve.json"), "utf8"))).toEqual(
			foreign,
		);
	});

	it.each([
		"missing binary",
		"failed removal",
	])("keeps an opt-out off and retries owned root cleanup after a %s", async (failure) => {
		const first = await start({ port: 0, tailscaleServe: true });
		await first.stop();
		if (failure === "missing binary") {
			vi.stubEnv("CONDUIT_TAILSCALE_BIN", join(root, "missing-tailscale"));
		} else {
			writeFileSync(join(root, "fail-serve"), "");
		}
		const disabled = await start({ tailscaleServe: false });
		await expectHttp(disabled);
		expect(disabled.getStatus().tailscaleServe).toBeUndefined();
		await disabled.stop();
		expect(loadDaemonConfig(configDir)).toMatchObject({
			tailscaleServe: false,
			tailscaleServeCleanupPending: true,
		});
		vi.stubEnv("CONDUIT_TAILSCALE_BIN", binary);
		rmSync(join(root, "fail-serve"), { force: true });
		const beforeRetry = invocations().length;
		const retried = await start({ tailscaleServe: false });
		await expectHttp(retried);
		expect(retried.getStatus().tailscaleServe).toBeUndefined();
		expect(invocations().slice(beforeRetry)).toEqual([
			["status", "--json"],
			["serve", "status", "--json"],
			["serve", `--https=${retried.port}`, "--set-path=/", "off"],
		]);
		expect(JSON.parse(readFileSync(join(root, "serve.json"), "utf8"))).toEqual({
			Web: {
				...otherHandlers().Web,
				[`${dnsName}:${retried.port}`]: { Handlers: {} },
			},
		});
		await retried.stop();
		expect(
			loadDaemonConfig(configDir)?.tailscaleServeCleanupPending,
		).toBeUndefined();
	});

	it("respects an explicit bind host", async () => {
		const daemon = await start({
			port: 0,
			host: "0.0.0.0",
			tailscaleServe: true,
		});
		expect(daemon.getStatus()).toMatchObject({
			host: "0.0.0.0",
			tlsEnabled: false,
			tailscaleServe: { url: `https://${dnsName}:${daemon.port}` },
		});
	});

	it("does not invoke Tailscale when the mode was already off", async () => {
		const daemon = await start({ port: 0, tailscaleServe: false });
		await expectHttp(daemon);
		expect(daemon.getStatus().tailscaleServe).toBeUndefined();
		expect(invocations()).toEqual([]);
	});
});
