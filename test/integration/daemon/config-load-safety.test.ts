/* Failure modes covered through the foreground daemon and its config-saving RPC:
 * - Bad JSON, invalid settings/accounts, or a newer config version boot on defaults.
 * - An I/O or permission failure is mistaken for a missing file.
 * - Startup migrations overwrite a file they could not decode.
 * - Separate startup reads seed runtime settings and the registry differently.
 * - A save overwrites an invalid/unreadable file, or cannot create a missing file.
 * - Legacy folder/account metadata is lost during the versioned startup rewrite.
 * - An unsupported RPC driver enters runtime state and prevents subsequent saves.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AddInstance,
	GetInstances,
	GetStatus,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const DIST = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");

describe("foreground config safety", { timeout: 90_000 }, () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	function createFixture(name: string) {
		scenario = name;
		const fixture = ProcessHarness.create({ dist: DIST, foregroundCli: true });
		harness = fixture;
		const configPath = join(fixture.configDir, "daemon.json");
		const probePath = join(fixture.root, "config-probe.json");
		const preloadPath = join(fixture.root, "config-probe.mjs");
		writeFileSync(
			preloadPath,
			`import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const configPath = ${JSON.stringify(configPath)};
const probePath = ${JSON.stringify(probePath)};
const originalWrite = fs.writeFileSync;
const events = [];
function record(kind) {
  events.push({ kind, ...(kind === "read" ? { writer: new Error().stack.includes("config-persistence-layer") } : {}) });
  originalWrite(probePath, JSON.stringify(events));
}
for (const [owner, key] of [[fs, "readFileSync"], [fs, "readFile"], [promises, "readFile"]]) {
  const original = owner[key];
  owner[key] = function (...args) {
    if (String(args[0]) === configPath) record("read");
    return original.apply(this, args);
  };
}
const originalAsyncWrite = promises.writeFile;
promises.writeFile = function (...args) {
  if (String(args[0]).includes("/.daemon.json.tmp.")) record("write");
  return originalAsyncWrite.apply(this, args);
};
process.on("exit", (code) => record("exit:" + code));
syncBuiltinESMExports();
`,
		);
		return {
			harness: fixture,
			configPath,
			probePath,
			start: () =>
				fixture.restart({
					startupTimeoutMs: 60_000,
					// Bypass the harness's seed rewrite so the daemon sees the exact fixture.
					opencodeUrl: "http://127.0.0.1:0",
					skipBrowserProbe: true,
					serviceEnvironment: { NODE_OPTIONS: `--import=${preloadPath}` },
				}),
		};
	}

	afterEach(async () => {
		if (!harness) return;
		const logs = harness.logTail;
		try {
			await harness.dispose();
			harness.assertNoRunners();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/g4zp-1-${scenario}.json`,
				JSON.stringify({ ...evidence, logs }, null, 2),
			);
			harness = undefined;
			evidence = {};
		}
	});

	it("rejects unsupported driver mutations without poisoning subsequent saves", async () => {
		const fixture = createFixture("invalid-driver-mutation");
		await fixture.start();
		const added = await fixture.harness.requestRpc(
			new AddInstance({
				name: "Valid account",
				driver: "claude",
			}),
		);
		const instanceId = added.addedInstanceId;
		if (!instanceId) throw new Error("Missing added account id");
		await expect(
			fixture.harness.requestRpc(
				new AddInstance({
					name: "Invalid account",
					driver: "future",
					managed: false,
					port: 49152,
				}),
			),
		).rejects.toThrow(/claude|opencode/);
		await expect(
			fixture.harness.requestRpc(
				new UpdateInstance({
					instanceId,
					driver: "future",
					name: "Invalid edit",
				}),
			),
		).rejects.toThrow(/claude|opencode/);
		const accounts = await fixture.harness.requestRpc(new GetInstances({}));
		expect(accounts.instances).toContainEqual(
			expect.objectContaining({
				id: instanceId,
				name: "Valid account",
				driver: "claude",
			}),
		);
		expect(
			accounts.instances.some(({ name }) => name === "Invalid account"),
		).toBe(false);
		await fixture.harness.requestRpc(
			new UpdateInstance({ instanceId: "claude", name: "Save still works" }),
		);
		const saved = loadDaemonConfig(fixture.harness.configDir);
		expect(saved?.instances).toContainEqual(
			expect.objectContaining({ id: "claude", name: "Save still works" }),
		);
		evidence = { rejectedBeforeMutation: true, subsequentSaveSucceeded: true };
	});

	it.each([
		["bad-json", "{ broken daemon config", /JSON|Unexpected|Expected/i],
		["bad-schema", JSON.stringify({ port: "wrong" }), /pid|port/],
		["newer-version", "newer", /configVersion/],
		["unknown-driver", "driver", /driver/],
		["bad-legacy-folders", "folders", /folders/],
	] as const)("refuses %s without changing the config or migration sources", async (name, input, cause) => {
		const fixture = createFixture(name);
		const seed = loadDaemonConfig(fixture.harness.configDir);
		if (!seed) throw new Error("Missing fixture config");
		const content =
			input === "newer"
				? JSON.stringify({ ...seed, configVersion: 9999 })
				: input === "driver"
					? JSON.stringify({
							...seed,
							instances: [
								{
									id: "unknown",
									name: "Unknown",
									port: 0,
									managed: false,
									driver: "future",
								},
							],
						})
					: input === "folders"
						? JSON.stringify({
								...seed,
								projects: [
									{
										...seed.projects[0],
										directory: fixture.harness.projectDir,
										folders: [],
									},
								],
							})
						: input;
		writeFileSync(fixture.configPath, content);
		const sidecar = join(fixture.harness.configDir, "fork-metadata.json");
		writeFileSync(sidecar, '{"unresolved":"message"}');
		await expect(fixture.start()).rejects.toThrow("Server exited before ready");
		expect(fixture.harness.logTail).toContain(fixture.configPath);
		expect(fixture.harness.logTail).toMatch(cause);
		expect(readFileSync(fixture.configPath, "utf8")).toBe(content);
		expect(readFileSync(sidecar, "utf8")).toBe('{"unresolved":"message"}');
		expect(JSON.parse(readFileSync(fixture.probePath, "utf8"))).toContainEqual({
			kind: "exit:1",
		});
		evidence = { unchanged: true, exitCode: 1, configPath: fixture.configPath };
	});

	it("refuses a permission-denied config without changing it", async () => {
		const fixture = createFixture("unreadable");
		const original = readFileSync(fixture.configPath);
		chmodSync(fixture.configPath, 0o000);
		try {
			await expect(fixture.start()).rejects.toThrow(
				"Server exited before ready",
			);
			expect(fixture.harness.logTail).toContain(fixture.configPath);
			expect(fixture.harness.logTail).toMatch(/EACCES|permission denied/i);
			expect(
				JSON.parse(readFileSync(fixture.probePath, "utf8")),
			).toContainEqual({ kind: "exit:1" });
		} finally {
			chmodSync(fixture.configPath, 0o600);
		}
		expect(readFileSync(fixture.configPath)).toEqual(original);
		evidence = { unchanged: true, exitCode: 1 };
	});

	it("creates a versioned default config on first start", async () => {
		const fixture = createFixture("first-start");
		unlinkSync(fixture.configPath);
		await fixture.start();
		await expect.poll(() => existsSync(fixture.configPath)).toBe(true);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8"));
		expect(saved).toMatchObject({
			configVersion: 1,
			pinHash: null,
			tls: false,
			keepAwake: false,
			projects: [],
		});
		expect(
			(await fixture.harness.requestRpc(new GetInstances({}))).instances,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "claude", driver: "claude" }),
			]),
		);
		evidence = { created: true, saved };
	});

	it("seeds settings and accounts from one startup read and rewrites legacy folders", async () => {
		const fixture = createFixture("single-read");
		const seed = loadDaemonConfig(fixture.harness.configDir);
		if (!seed) throw new Error("Missing fixture config");
		const folder = join(fixture.harness.root, "saved-claude");
		mkdirSync(folder);
		writeFileSync(
			fixture.configPath,
			JSON.stringify({
				...seed,
				pinHash: "saved-pin-hash",
				instances: [
					{
						id: "claude",
						name: "Saved Claude",
						driver: "claude",
						port: 0,
						managed: false,
						configDir: folder,
					},
				],
				projects: seed.projects.map(({ folders, ...project }) => ({
					...project,
					directory: folders[0],
				})),
			}),
		);
		await fixture.start();
		const status = await fixture.harness.requestRpc(new GetStatus({}));
		const accounts = await fixture.harness.requestRpc(new GetInstances({}));
		expect(status.pinEnabled).toBe(true);
		expect(status.projects).toEqual([
			expect.objectContaining({
				slug: "process-test",
				folders: [fixture.harness.projectDir],
			}),
		]);
		expect(accounts.instances).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "claude",
					name: "Saved Claude",
					configDir: folder,
				}),
			]),
		);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8"));
		expect(saved.configVersion).toBe(1);
		expect(saved.claudeConfigDir).toBe(folder);
		expect(saved.projects[0].folders).toEqual([fixture.harness.projectDir]);
		expect(saved.projects[0]).not.toHaveProperty("directory");
		const probe: Array<{ kind: string; writer?: boolean }> = JSON.parse(
			readFileSync(fixture.probePath, "utf8"),
		);
		const startupReads = probe.filter(
			({ kind, writer }) => kind === "read" && !writer,
		);
		expect(startupReads).toHaveLength(1);
		evidence = {
			startupReads: startupReads.length,
			probe,
			status,
			accounts,
			saved,
		};
	});

	it.each([
		"invalid",
		"newer",
		"unreadable",
		"missing",
	] as const)("handles a %s file during an account save", async (kind) => {
		const fixture = createFixture(`save-${kind}`);
		await fixture.start();
		await fixture.harness.requestRpc(
			new UpdateInstance({ instanceId: "claude", name: "Before" }),
		);
		const original = readFileSync(fixture.configPath);
		const damaged =
			kind === "newer"
				? JSON.stringify({
						...JSON.parse(original.toString()),
						configVersion: 9999,
					})
				: "{ invalid config during save";
		if (kind === "missing") unlinkSync(fixture.configPath);
		else if (kind === "unreadable") chmodSync(fixture.configPath, 0o000);
		else writeFileSync(fixture.configPath, damaged);
		try {
			const request = fixture.harness.requestRpc(
				new UpdateInstance({ instanceId: "claude", name: "After" }),
			);
			if (kind === "missing") {
				await request;
				const saved = JSON.parse(readFileSync(fixture.configPath, "utf8"));
				expect(saved.configVersion).toBe(1);
				expect(saved.instances).toContainEqual(
					expect.objectContaining({ id: "claude", name: "After" }),
				);
			} else {
				await expect(request).rejects.toThrow(/saveDaemonConfig failed/);
				if (kind === "unreadable") chmodSync(fixture.configPath, 0o600);
				expect(readFileSync(fixture.configPath)).toEqual(
					kind === "unreadable" ? original : Buffer.from(damaged),
				);
			}
			evidence = {
				kind,
				saved: kind === "missing",
				unchanged: kind !== "missing",
			};
		} finally {
			chmodSync(fixture.configPath, 0o600);
			writeFileSync(fixture.configPath, original);
		}
	});
});
