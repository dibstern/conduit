/* Failure modes: missing config prevents first-run diagnostics; invalid JSON or
 * unreadable config is treated as an empty project list; diagnostics overwrite
 * the damaged file or inherit the developer's account/home.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "../../../src/bin/cli-core.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";

let home: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (home) rmSync(home, { recursive: true, force: true });
});

describe("conduit doctor", () => {
	it.each([
		"missing",
		"invalid",
		"unreadable",
	] as const)("handles a %s daemon config without replacing it", async (kind) => {
		home = mkdtempSync(join(tmpdir(), "conduit-doctor-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "claude"));
		const configDir = join(home, "config");
		const path = join(configDir, "daemon.json");
		mkdirSync(configDir);
		const damaged = "{ invalid daemon config";
		if (kind === "unreadable") mkdirSync(path);
		else if (kind === "invalid") writeFileSync(path, damaged);
		let output = "";
		const operation = run(["doctor"], {
			configDir,
			stdout: {
				write: (value) => {
					output += value;
				},
			},
		});
		if (kind === "missing") {
			await operation;
			expect(output).toContain("No registered projects");
		} else {
			await expect(operation).rejects.toMatchObject({
				_tag: kind === "invalid" ? "Invalid" : "Unreadable",
				path,
			});
			await expect(operation).rejects.toThrow(path);
			expect(output).not.toContain("No registered projects");
			if (kind === "invalid") expect(readFileSync(path, "utf8")).toBe(damaged);
		}
	});

	it("parses both the subcommand and --doctor", () => {
		expect(parseArgs(["doctor"]).command).toBe("doctor");
		expect(parseArgs(["--doctor"]).command).toBe("doctor");
	});

	it("reports every persisted project's locally resolved sources, time, warnings and tool PATH without contacting a daemon", async () => {
		home = mkdtempSync(join(tmpdir(), "conduit-doctor-"));
		const project = join(home, "project");
		const configDir = join(home, "config");
		const bin = join(project, "bin");
		mkdirSync(bin, { recursive: true });
		for (const name of ["claude", "node"]) {
			writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
			chmodSync(join(bin, name), 0o755);
		}
		writeFileSync(join(home, ".zprofile"), 'export PATH="/usr/bin:/bin"\n');
		vi.stubEnv("HOME", home);
		vi.stubEnv("ZDOTDIR", home);
		vi.stubEnv("SHELL", "/bin/zsh");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "claude"));
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				projects: [
					{
						path: project,
						folders: [project],
						slug: "working",
						addedAt: 1,
						shellEnv: {
							interactive: true,
							overrides: { PATH: bin, PRIVATE_ENV: "never-print-this" },
						},
					},
					{
						path: join(home, "missing-project"),
						folders: [join(home, "missing-project")],
						slug: "missing",
						addedAt: 2,
					},
				],
			},
			configDir,
		);
		expect(
			Either.getOrThrowWith(loadDaemonConfigResult(configDir), (error) => error)
				?.projects[0]?.shellEnv,
		).toEqual({
			interactive: true,
			overrides: { PATH: bin, PRIVATE_ENV: "never-print-this" },
		});
		let output = "";
		const ipc = vi.fn();
		const checkDaemon = vi.fn();
		await run(["doctor"], {
			configDir,
			stdout: {
				write: (value) => {
					output += value;
				},
			},
			sendRPC: ipc,
			isDaemonRunning: checkDaemon,
		});
		expect(output).toContain("Local environment check");
		expect(output).toContain("working");
		expect(output).toContain("login, interactive, overrides");
		expect(output).toMatch(/Last resolved: \d{4}-/);
		expect(output).toContain(`claude: ${join(bin, "claude")}`);
		expect(output).toContain(`node: ${join(bin, "node")}`);
		expect(output).toContain("opencode: missing");
		expect(output).toContain("Credentials:");
		expect(output).toContain("missing-project");
		expect(output).toContain("Warning:");
		expect(output).not.toContain("never-print-this");
		expect(ipc).not.toHaveBeenCalled();
		expect(checkDaemon).not.toHaveBeenCalled();
	});
});
