import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	claudeRunnerDirectory,
	discoverClaudeRunners,
} from "../../../src/lib/provider/claude/claude-runner-registry.js";
import { cleanupTestClaudeRunners } from "../../helpers/claude-runner-cleanup.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure cases: overflowing only the runner socket, losing discovery after a
// server restart, upgrading into a different directory, and leaving runners alive.
describe.skipIf(process.platform === "win32")(
	"Claude runner long socket paths",
	() => {
		it.each([
			"directory",
			"wrong-target",
		] as const)("rejects a shared tmp alias occupied by a %s", (kind) => {
			const root = mkdtempSync("/tmp/conduit-runner-alias-");
			const configDir = join(root, "x".repeat(90));
			const projectDir = join(root, "project");
			const alias = claudeRunnerDirectory(projectDir, configDir);
			try {
				mkdirSync(dirname(alias), { recursive: true });
				if (kind === "directory") mkdirSync(alias, { mode: 0o700 });
				else symlinkSync(root, alias);
				expect(() => discoverClaudeRunners(projectDir, configDir)).toThrow(
					/Unsafe.*alias/,
				);
			} finally {
				rmSync(alias, { recursive: true, force: true });
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("completes turns, re-adopts and upgrades through the same short alias", async () => {
			const prefix = "/tmp/conduit-runner-long-";
			const rootPrefix =
				prefix +
				"x".repeat(85 - Buffer.byteLength(prefix) - 6 - "/config".length);
			const evidence: Record<string, unknown> = {
				at: new Date().toISOString(),
				completed: false,
			};
			let harness: ProcessHarness | undefined;
			let alias: string | undefined;
			try {
				harness = await ProcessHarness.start({
					rootPrefix,
					restartProof: true,
					buildId: "85kb-15-long-path-original",
				});
				const projectHash = createHash("sha256")
					.update(resolve(harness.projectDir))
					.digest("hex")
					.slice(0, 12);
				const normalDirectory = join(
					resolve(harness.configDir),
					"r",
					projectHash,
				);
				const oldSocketBytes = Buffer.byteLength(
					join(normalDirectory, "0".repeat(12)),
				);
				const relaySocketBytes = Buffer.byteLength(
					join(harness.configDir, "relay.sock"),
				);
				evidence["paths"] = {
					configDir: harness.configDir,
					oldSocketBytes,
					relaySocketBytes,
				};
				expect(Buffer.byteLength(harness.configDir)).toBe(85);
				expect(oldSocketBytes).toBeGreaterThanOrEqual(104);
				expect(relaySocketBytes).toBeLessThan(104);

				let browser = await harness.connect();
				const sessionId = await browser.createSession("Long runner socket");
				const first = await browser.send(sessionId, "long-path-before-restart");
				evidence["firstTurn"] = first;
				expect(first.chunks).toEqual(
					responseChunks("long-path-before-restart"),
				);
				expect(first.done["code"]).toBe(0);
				const original = harness.marks.find(
					(mark) => mark.kind === "runner-started",
				);
				if (original?.kind !== "runner-started")
					throw new Error("Missing runner proof");
				evidence["original"] = original;
				expect(original.pid).not.toBe(harness.generations[0]?.pid);
				expect(Buffer.byteLength(original.socketPath)).toBeLessThan(104);
				alias = dirname(original.socketPath);
				expect(alias).not.toBe(normalDirectory);
				expect(lstatSync(alias).isSymbolicLink()).toBe(true);
				expect(lstatSync(alias).uid).toBe(process.getuid?.());
				expect(readlinkSync(alias)).toBe(normalDirectory);
				expect(statSync(normalDirectory).mode & 0o777).toBe(0o700);
				expect(statSync(normalDirectory).uid).toBe(process.getuid?.());
				expect(
					JSON.parse(readFileSync(`${original.socketPath}.json`, "utf8")),
				).toMatchObject({
					pid: original.pid,
					sessionId,
					socketPath: original.socketPath,
				});
				expect(
					discoverClaudeRunners(harness.projectDir, harness.configDir),
				).toMatchObject([
					{ pid: original.pid, socketPath: original.socketPath },
				]);

				await harness.kill();
				expect(() => process.kill(original.pid, 0)).not.toThrow();
				const adoptionCursor = harness.marks.length;
				await harness.restart();
				browser = await harness.connect(sessionId);
				const adopted = harness.marks
					.slice(adoptionCursor)
					.find((mark) => mark.kind === "runner-started");
				expect(adopted).toMatchObject({
					pid: original.pid,
					socketPath: original.socketPath,
				});
				evidence["adopted"] = adopted;
				const second = await browser.send(sessionId, "long-path-after-restart");
				expect(second.chunks).toEqual(
					responseChunks("long-path-after-restart"),
				);
				expect(second.done["code"]).toBe(0);

				await harness.kill();
				const upgradeCursor = harness.marks.length;
				await harness.restart({ buildId: "85kb-15-long-path-upgraded" });
				browser = await harness.connect(sessionId);
				const activeHarness = harness;
				await vi.waitFor(
					() => {
						const replacement = activeHarness.marks
							.slice(upgradeCursor)
							.find(
								(mark) =>
									mark.kind === "runner-started" &&
									mark.buildId === "85kb-15-long-path-upgraded",
							);
						expect(replacement).toBeDefined();
						if (replacement?.kind !== "runner-started")
							throw new Error("Missing upgrade proof");
						expect(replacement.pid).not.toBe(original.pid);
						expect(dirname(replacement.socketPath)).toBe(alias);
						expect(Buffer.byteLength(replacement.socketPath)).toBeLessThan(104);
						expect(() => process.kill(original.pid, 0)).toThrow();
						expect(existsSync(`${original.socketPath}.json`)).toBe(false);
						expect(
							discoverClaudeRunners(
								activeHarness.projectDir,
								activeHarness.configDir,
							),
						).toMatchObject([
							{ pid: replacement.pid, socketPath: replacement.socketPath },
						]);
						evidence["replacement"] = replacement;
					},
					{ timeout: 20_000 },
				);
				const third = await browser.send(sessionId, "long-path-after-upgrade");
				expect(third.chunks).toEqual(responseChunks("long-path-after-upgrade"));
				expect(third.done["code"]).toBe(0);
				const history = JSON.stringify(await browser.history(sessionId));
				for (const prompt of [
					"long-path-before-restart",
					"long-path-after-restart",
					"long-path-after-upgrade",
				])
					expect(history).toContain(responseChunks(prompt).join(""));
				await harness.kill();
				const cleanup = await cleanupTestClaudeRunners(
					harness.root,
					[],
					harness.configDir,
				);
				evidence["registrationOnlyCleanup"] = cleanup;
				expect(cleanup.runnerPids).toHaveLength(1);
				expect(cleanup.remainingPids).toEqual([]);
				for (const pid of cleanup.runnerPids)
					expect(() => process.kill(pid, 0)).toThrow();
				evidence["completed"] = true;
			} finally {
				try {
					await harness?.dispose();
				} finally {
					evidence["runnerPids"] = harness?.runnerPids() ?? [];
					evidence["remainingRunnerPids"] =
						harness?.remainingRunnerPids() ?? [];
					evidence["harness"] = harness?.proof();
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/85kb-15-long-socket-path.json",
						`${JSON.stringify(evidence, null, 2)}\n`,
					);
					expect(harness?.remainingRunnerPids() ?? []).toEqual([]);
					if (alias) rmSync(alias, { force: true });
				}
			}
		}, 120_000);
	},
);
