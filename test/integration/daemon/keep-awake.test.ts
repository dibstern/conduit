// Failure cases: enabling never spawns, command changes leave the old child,
// disabling or daemon shutdown leaks a child, status reports a stale command,
// or persisted keepAwake fails to spawn at boot.
// Run after building: CONDUIT_TEST_DIST=dist pnpm exec vitest run
// --config vitest.integration.config.ts test/integration/daemon/keep-awake.test.ts

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetStatus,
	SetKeepAwake,
	SetKeepAwakeCommand,
	Shutdown,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_LOG = "test-results/keep-awake/run.log";

function record(event: string, data: Record<string, unknown> = {}): void {
	appendFileSync(
		RUN_LOG,
		`${JSON.stringify({ time: new Date().toISOString(), event, ...data })}\n`,
	);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH")
			return false;
		throw error;
	}
}

// The daemon owns other children (git, OpenCode helpers), so count only the
// commands this test configures.
const KEEP_AWAKE_COMMAND = /^(\S*\/)?(caffeinate|sleep)\s/;

function children(pid: number): Array<{ pid: number; command: string }> {
	const result = spawnSync("pgrep", ["-P", String(pid)], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 4096,
	});
	if (result.error) throw result.error;
	if (result.status === 1) return [];
	if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
	const pids = result.stdout.trim().split(/\s+/);
	const table = execFileSync(
		"ps",
		["-o", "pid=,command=", "-p", pids.join(",")],
		{
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 16_384,
		},
	);
	return table
		.trim()
		.split("\n")
		.map((line) => {
			const match = /^\s*(\d+)\s+(.+)$/.exec(line);
			if (!match) throw new Error(`Invalid ps row: ${line}`);
			return { pid: Number(match[1]), command: match[2] ?? "" };
		})
		.filter((row) => KEEP_AWAKE_COMMAND.test(row.command));
}

describe("daemon keep-awake", () => {
	let harness: ProcessHarness | undefined;
	const ownedPids = new Set<number>();

	async function waitForChild(daemonPid: number, command: RegExp) {
		return vi.waitFor(
			() => {
				const rows = children(daemonPid);
				for (const row of rows)
					if (command.test(row.command)) ownedPids.add(row.pid);
				expect(rows).toHaveLength(1);
				const child = rows[0];
				if (!child) throw new Error("No keep-awake child");
				expect(child.command).toMatch(command);
				return child;
			},
			{ timeout: 5000 },
		);
	}

	afterEach(async () => {
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			const remaining = [...ownedPids].filter(alive);
			record("cleanup", { remaining, proof: harness.proof() });
			// Only signal children observed under this isolated daemon.
			for (const pid of remaining) process.kill(pid, "SIGKILL");
			harness = undefined;
			ownedPids.clear();
			expect(remaining).toEqual([]);
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"spawns, replaces, stops, and restores the persisted command",
		async () => {
			mkdirSync("test-results/keep-awake", { recursive: true });
			writeFileSync(RUN_LOG, "");
			record("start", {
				platform: process.platform,
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				foregroundCli: true,
			});
			try {
				await harness.restart({ skipBrowserProbe: true });
				const initial = harness.generations.at(-1);
				if (!initial) throw new Error("No daemon generation");
				const socket = join(harness.configDir, "relay.sock");
				const before = await sendRpcRequest(socket, new GetStatus({}));
				expect(before.keepAwake).toBe(false);
				expect(before.keepAwakeCommand).toBe("caffeinate -di");
				expect(children(initial.pid)).toEqual([]);
				record("disabled-at-boot", { daemonPid: initial.pid, status: before });

				const enabled = await sendRpcRequest(
					socket,
					new SetKeepAwake({ enabled: true }),
				);
				expect(enabled).toEqual({ ok: true, supported: true, active: true });
				const original = await waitForChild(
					initial.pid,
					/(?:^|\/)caffeinate -di$/,
				);
				record("enabled", {
					daemonPid: initial.pid,
					child: original,
					response: enabled,
				});

				await sendRpcRequest(
					socket,
					new SetKeepAwakeCommand({ command: "sleep", args: ["86400"] }),
				);
				const replacement = await waitForChild(
					initial.pid,
					/(?:^|\/)sleep 86400$/,
				);
				expect(replacement.pid).not.toBe(original.pid);
				await vi.waitFor(() => expect(alive(original.pid)).toBe(false), {
					timeout: 5000,
				});
				const changed = await sendRpcRequest(socket, new GetStatus({}));
				expect(changed.keepAwake).toBe(true);
				expect(changed.keepAwakeCommand).toBe("sleep 86400");
				record("command-replaced", {
					original,
					replacement,
					oldAlive: alive(original.pid),
					status: changed,
				});

				const disabled = await sendRpcRequest(
					socket,
					new SetKeepAwake({ enabled: false }),
				);
				expect(disabled).toEqual({ ok: true, supported: true, active: false });
				await vi.waitFor(
					() => {
						expect(alive(replacement.pid)).toBe(false);
						expect(children(initial.pid)).toEqual([]);
					},
					{ timeout: 5000 },
				);
				const off = await sendRpcRequest(socket, new GetStatus({}));
				expect(off.keepAwake).toBe(false);
				expect(off.keepAwakeCommand).toBe("sleep 86400");
				record("disabled", { childAlive: alive(replacement.pid), status: off });

				await sendRpcRequest(socket, new SetKeepAwake({ enabled: true }));
				const beforeRestart = await waitForChild(
					initial.pid,
					/(?:^|\/)sleep 86400$/,
				);
				await harness.signal("SIGTERM");
				expect(initial.exitCode).toBe(0);
				expect(initial.signal).toBeNull();
				await vi.waitFor(() => expect(alive(beforeRestart.pid)).toBe(false), {
					timeout: 5000,
				});
				const persisted = loadDaemonConfig(harness.configDir);
				expect(persisted?.keepAwake).toBe(true);
				expect(persisted?.keepAwakeCommand).toBe("sleep");
				expect(persisted?.keepAwakeArgs).toEqual(["86400"]);
				record("signal-shutdown", {
					daemonPid: initial.pid,
					child: beforeRestart,
					childAlive: alive(beforeRestart.pid),
					persisted,
				});

				await harness.restart({ skipBrowserProbe: true });
				const rebooted = harness.generations.at(-1);
				if (!rebooted) throw new Error("No restarted daemon generation");
				expect(rebooted.pid).not.toBe(initial.pid);
				const bootChild = await waitForChild(
					rebooted.pid,
					/(?:^|\/)sleep 86400$/,
				);
				const restored = await sendRpcRequest(socket, new GetStatus({}));
				expect(restored.keepAwake).toBe(true);
				expect(restored.keepAwakeCommand).toBe("sleep 86400");
				record("restored-at-boot", {
					daemonPid: rebooted.pid,
					child: bootChild,
					status: restored,
				});

				await sendRpcRequest(socket, new Shutdown({}));
				await harness.waitForExit();
				expect(rebooted.exitCode).toBe(0);
				expect(rebooted.signal).toBeNull();
				await vi.waitFor(() => expect(alive(bootChild.pid)).toBe(false), {
					timeout: 5000,
				});
				record("stopped", {
					daemonPid: rebooted.pid,
					childAlive: alive(bootChild.pid),
					children: children(rebooted.pid),
				});
				record("passed");
			} catch (error) {
				record("failed", {
					error: error instanceof Error ? error.stack : String(error),
					daemonLog: harness.logTail,
				});
				throw error;
			}
		},
		60_000,
	);
});
