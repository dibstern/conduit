// Failure cases are specified before implementation: wrong login shell or
// foreground flags, pinned node paths, shell/XML/systemd expansion, missing
// executables, existing services/daemons/listeners, failed service-manager or
// filesystem operations, stopped/missing services, and removing a unit before
// its process has stopped. Every effect below uses an in-memory runner.

import * as childProcess from "node:child_process";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "../../../src/bin/cli-core.js";
import * as service from "../../../src/bin/cli-service.js";
import {
	foregroundArguments,
	generateServiceUnit,
	getServicePaths,
	handleService,
	runServiceCommand,
	type ServiceOptions,
	type ServiceRunner,
} from "../../../src/bin/cli-service.js";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, execFile: vi.fn() };
});

const homeDir = "/home/test user";
const configDir = `${homeDir}/.config/conduit`;
const cwd = `${homeDir}/project`;
const cliEntry = `${homeDir}/installed/dist/src/bin/cli.js`;
const absentLaunchd = {
	code: 113,
	stdout: "",
	stderr:
		'Could not find service "dev.conduit.server" in domain for user gui:501',
};
const absentSystemd = {
	code: 0,
	stdout:
		"LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
	stderr: "",
};

function options(platform: NodeJS.Platform): ServiceOptions {
	return {
		platform,
		shell: "/bin/zsh",
		command: ["conduit", "--foreground", "--port", "7777"],
		paths: getServicePaths(platform, homeDir, configDir, cwd),
		uid: 501,
		cliEntry,
		port: 7777,
		environment: {
			HOME: homeDir,
			USER: "testuser",
			LOGNAME: "testuser",
			SHELL: "/bin/zsh",
		},
	};
}

function fakeRunner(platform: NodeJS.Platform) {
	const files = new Map<string, string>([[cliEntry, "installed CLI"]]);
	const events: string[] = [];
	const runner = {
		exec: vi.fn<ServiceRunner["exec"]>(async (command, args) => {
			events.push(`${command} ${args.join(" ")}`);
			if (command === "launchctl" && args[0] === "print") {
				return absentLaunchd;
			}
			if (command === "systemctl" && args[1] === "show") {
				return absentSystemd;
			}
			return { code: 0, stdout: "", stderr: "" };
		}),
		exists: vi.fn<ServiceRunner["exists"]>(async (path) => files.has(path)),
		readFile: vi.fn<ServiceRunner["readFile"]>(async (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`Missing file: ${path}`);
			return content;
		}),
		mkdir: vi.fn<ServiceRunner["mkdir"]>(async (path) => {
			events.push(`mkdir ${path}`);
		}),
		writeFile: vi.fn<ServiceRunner["writeFile"]>(async (path, content) => {
			events.push(`write ${path}`);
			files.set(path, content);
		}),
		removeFile: vi.fn<ServiceRunner["removeFile"]>(async (path) => {
			events.push(`remove ${path}`);
			files.delete(path);
		}),
		checkDaemon: vi.fn<ServiceRunner["checkDaemon"]>(async () => false),
		isPortAvailable: vi.fn<ServiceRunner["isPortAvailable"]>(async () => true),
	} satisfies ServiceRunner;
	return { runner, files, events, config: options(platform) };
}

function loaded(
	runner: ReturnType<typeof fakeRunner>["runner"],
	platform: NodeJS.Platform,
	pid = 42,
) {
	runner.exec.mockImplementation(async (command, args) => {
		if (command === "launchctl" && args[0] === "print") {
			return {
				code: 0,
				stdout: `gui/501/dev.conduit.server = {\n\tstate = ${pid ? "running" : "waiting"}\n\tpid = ${pid}\n}`,
				stderr: "",
			};
		}
		if (command === "systemctl" && args[1] === "show") {
			return {
				code: 0,
				stdout: `LoadState=loaded\nActiveState=${pid ? "active" : "inactive"}\nSubState=${pid ? "running" : "dead"}\nMainPID=${pid}\n`,
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	});
	return options(platform);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("service unit generation", () => {
	it("uses the XDG configuration root for Linux units without moving Conduit's logs", () => {
		const paths = getServicePaths(
			"linux",
			homeDir,
			configDir,
			cwd,
			"/xdg/custom config",
		);
		expect(paths.unitFile).toBe(
			"/xdg/custom config/systemd/user/conduit.service",
		);
		expect(paths.configDir).toBe(configDir);
		expect(paths.stdout).toBe(`${configDir}/service.stdout.log`);
		expect(
			getServicePaths("darwin", homeDir, configDir, cwd, "/xdg/custom config")
				.unitFile,
		).toBe(options("darwin").paths.unitFile);
	});

	it("keeps literal dollars in the systemd executable while escaping script arguments", () => {
		const config = options("linux");
		config.shell = "/home/user/$tools/bin/bash";
		config.command = [
			"conduit",
			"--foreground",
			"--claude-config-dir",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Test literal systemd expansion without interpolating it.
			"/profiles/${PROFILE}",
		];
		const unit = generateServiceUnit(config);
		expect(unit).toContain('ExecStart="/home/user/$tools/bin/bash" -l -c ');
		expect(unit).not.toContain("/home/user/$$tools/bin/bash");
		expect(unit).toContain("/profiles/$${PROFILE}");
	});

	it("builds a launchd user agent around the login shell and foreground command", () => {
		const config = options("darwin");
		const unit = generateServiceUnit(config);
		expect(config.paths.unitFile).toBe(
			`${homeDir}/Library/LaunchAgents/dev.conduit.server.plist`,
		);
		expect(unit).toContain("<string>dev.conduit.server</string>");
		expect(unit).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(unit).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		expect(unit).toMatch(
			/<string>\/bin\/zsh<\/string>\s*<string>-l<\/string>\s*<string>-c<\/string>\s*<string>exec conduit --foreground --port 7777<\/string>/,
		);
		expect(unit).toContain(`<string>${cwd}</string>`);
		expect(unit).toContain(`<string>${configDir}</string>`);
		expect(unit).toContain(`<string>${config.paths.stdout}</string>`);
		expect(unit).toContain(`<string>${config.paths.stderr}</string>`);
		expect(unit).not.toMatch(/\/[^\s<]*\/node(?:\s|<)/);
	});

	it("builds a systemd user unit with a single login-shell command", () => {
		const config = options("linux");
		const unit = generateServiceUnit(config);
		expect(config.paths.unitFile).toBe(
			`${homeDir}/.config/systemd/user/conduit.service`,
		);
		expect(unit).toContain(
			'ExecStart="/bin/zsh" -l -c "exec conduit --foreground --port 7777"',
		);
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).toContain(`WorkingDirectory=${cwd}`);
		expect(unit).toContain(`Environment="CONDUIT_CONFIG_DIR=${configDir}"`);
		expect(unit).toContain(`StandardOutput=append:${config.paths.stdout}`);
		expect(unit).toContain(`StandardError=append:${config.paths.stderr}`);
		expect(unit).not.toMatch(/\/[^\s"]*\/node(?:\s|")/);
	});

	it("escapes XML and keeps shell metacharacters inside one argument", () => {
		const config = options("darwin");
		config.command = [
			"conduit",
			"--foreground",
			"--claude-config-dir",
			"/profiles/O'Brien & <work> $(ignored)",
		];
		const unit = generateServiceUnit(config);
		expect(unit).toContain("&amp;");
		expect(unit).toContain("&lt;work&gt;");
		expect(unit).toContain("&apos;&quot;&apos;&quot;&apos;");
		expect(unit).not.toContain("<work>");
	});

	it("escapes systemd expansion separately from shell quoting", () => {
		const config = options("linux");
		config.command = [
			"conduit",
			"--foreground",
			"--claude-config-dir",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Test literal systemd expansion without interpolating it.
			"/profiles/50% ${TOKEN} O'Brien \\quoted\"",
		];
		config.paths = getServicePaths(
			"linux",
			homeDir,
			`${configDir}/50%`,
			`${cwd}/50%`,
		);
		const unit = generateServiceUnit(config);
		expect(unit).toContain("50%% $${TOKEN}");
		expect(unit).toContain("O'\\\"'\\\"'Brien");
		expect(unit).toContain('\\\\quoted\\"');
		expect(unit).toContain(`WorkingDirectory=${cwd}/50%%`);
		expect(unit).toContain(
			`StandardOutput=append:${configDir}/50%%/service.stdout.log`,
		);
	});

	it.each([
		"darwin",
		"linux",
	] as const)("uses PATH node for the absolute CLI fallback on %s", (platform) => {
		const config = options(platform);
		config.command = ["node", cliEntry, "--foreground"];
		const unit = generateServiceUnit(config);
		expect(unit).toContain("exec node");
		expect(unit).toContain(cliEntry.replaceAll("'", "&apos;"));
		expect(unit).not.toContain(process.execPath);
	});

	it.each([
		"darwin",
		"linux",
	] as const)("rejects unit injection and a relative shell on %s", (platform) => {
		const config = options(platform);
		expect(() => generateServiceUnit({ ...config, shell: "zsh" })).toThrow(
			/absolute.*shell|shell.*absolute/i,
		);
		expect(() =>
			generateServiceUnit({
				...config,
				command: ["conduit", "bad\n[Service]"],
			}),
		).toThrow(/control|newline/i);
		expect(() => generateServiceUnit({ ...config, command: [] })).toThrow(
			/command/i,
		);
	});

	it("rejects platforms without launchd or systemd", () => {
		expect(() => getServicePaths("win32", homeDir, configDir, cwd)).toThrow(
			/macOS.*Linux/,
		);
	});

	it("preserves the foreground server's flags without propagating daemon restart", () => {
		const args = parseArgs([
			"service",
			"install",
			"--port",
			"7777",
			"--host",
			"127.0.0.2",
			"--oc-port",
			"4999",
			"--claude-config-dir",
			"/profiles/work",
			"--no-https",
			"--log-level",
			"debug",
			"--log-format",
			"json",
			"--restart-daemon",
		]);
		expect(foregroundArguments(args)).toEqual([
			"--foreground",
			"--port",
			"7777",
			"--oc-port",
			"4999",
			"--log-level",
			"debug",
			"--host",
			"127.0.0.2",
			"--claude-config-dir",
			"/profiles/work",
			"--no-https",
			"--log-format",
			"json",
		]);
	});
});

describe.each([
	"darwin",
	"linux",
] as const)("service commands on %s", (platform) => {
	it("installs only after conflict checks and directory creation", async () => {
		const { runner, events, files, config } = fakeRunner(platform);
		const output = await runServiceCommand("install", config, runner);
		expect(runner.checkDaemon).toHaveBeenCalledOnce();
		expect(runner.isPortAvailable).toHaveBeenCalledWith(7777, "0.0.0.0");
		expect(events).toEqual([
			platform === "darwin"
				? "launchctl print gui/501/dev.conduit.server"
				: "systemctl --user show conduit --property=LoadState,ActiveState,SubState,MainPID",
			"/bin/zsh -l -c command -v conduit >/dev/null 2>&1",
			`mkdir ${dirname(config.paths.unitFile)}`,
			`mkdir ${configDir}`,
			`write ${config.paths.unitFile}`,
			...(platform === "darwin"
				? [
						"launchctl enable gui/501/dev.conduit.server",
						`launchctl bootstrap gui/501 ${config.paths.unitFile}`,
					]
				: [
						"systemctl --user daemon-reload",
						"systemctl --user enable --now conduit",
					]),
		]);
		expect(files.get(config.paths.unitFile)).toBe(generateServiceUnit(config));
		expect(output).toContain("Installed");
		expect(output).toContain(config.paths.stdout);
		expect(output).toContain(config.paths.stderr);
	});

	it("passes an explicit bind address to the port check", async () => {
		const { runner, config } = fakeRunner(platform);
		await runServiceCommand(
			"install",
			{ ...config, host: "127.0.0.2" },
			runner,
		);
		expect(runner.isPortAvailable).toHaveBeenCalledWith(7777, "127.0.0.2");
	});

	it("refuses a self-daemonised server without writing or starting a service", async () => {
		const { runner, config } = fakeRunner(platform);
		runner.checkDaemon.mockResolvedValue(true);
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/stop.*conduit --stop/i,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
		expect(runner.mkdir).not.toHaveBeenCalled();
		expect(runner.isPortAvailable).not.toHaveBeenCalled();
		expect(runner.exec.mock.calls).toHaveLength(1);
	});

	it("refuses an occupied port without installing a restart loop", async () => {
		const { runner, config } = fakeRunner(platform);
		runner.isPortAvailable.mockResolvedValue(false);
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/port 7777.*in use/i,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
	});

	it("never overwrites an installed service", async () => {
		const { runner, files, config } = fakeRunner(platform);
		files.set(config.paths.unitFile, generateServiceUnit(config));
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/already installed.*uninstall/i,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
		expect(runner.checkDaemon).not.toHaveBeenCalled();
	});

	it("does not start a second instance when a unit was deleted but is still loaded", async () => {
		const { runner, config } = fakeRunner(platform);
		loaded(runner, platform);
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/already.*uninstall/i,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
	});

	it("warns and uses the installed entry when conduit is absent from login PATH", async () => {
		const { runner, config, files } = fakeRunner(platform);
		const execute = runner.exec.getMockImplementation();
		runner.exec.mockImplementation(async (command, args) => {
			if (command === config.shell && args[2]?.includes("command -v conduit")) {
				return { code: 1, stdout: "", stderr: "" };
			}
			if (!execute) throw new Error("Missing fake execution");
			return execute(command, args);
		});
		const output = await runServiceCommand("install", config, runner);
		expect(output).toMatch(/Warning:.*login shell PATH/);
		expect(output).toContain(cliEntry);
		const unit = files.get(config.paths.unitFile);
		expect(unit).toContain("exec node");
		expect(unit).toContain(cliEntry);
		expect(unit).not.toContain(process.execPath);
		expect(runner.exec).toHaveBeenCalledWith(
			config.shell,
			["-l", "-c", "command -v node >/dev/null 2>&1"],
			expect.objectContaining({ HOME: homeDir }),
		);
	});

	it("fails before writing if neither conduit nor its installed entry exists", async () => {
		const { runner, config, files } = fakeRunner(platform);
		files.delete(cliEntry);
		runner.exec
			.mockResolvedValueOnce(
				platform === "darwin" ? absentLaunchd : absentSystemd,
			)
			.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/installed CLI entry/,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
	});

	it("fails before writing if node is also absent from login PATH", async () => {
		const { runner, config } = fakeRunner(platform);
		runner.exec
			.mockResolvedValueOnce(
				platform === "darwin" ? absentLaunchd : absentSystemd,
			)
			.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/node.*login shell PATH/,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
	});

	it("stops the service before removing its unit", async () => {
		const { runner, config, files } = fakeRunner(platform);
		files.set(config.paths.unitFile, generateServiceUnit(config));
		loaded(runner, platform);
		const output = await runServiceCommand("uninstall", config, runner);
		expect(runner.exec.mock.calls).toEqual(
			platform === "darwin"
				? [
						["launchctl", ["print", "gui/501/dev.conduit.server"]],
						["launchctl", ["bootout", "gui/501/dev.conduit.server"]],
					]
				: [
						[
							"systemctl",
							[
								"--user",
								"show",
								"conduit",
								"--property=LoadState,ActiveState,SubState,MainPID",
							],
						],
						["systemctl", ["--user", "disable", "--now", "conduit"]],
						["systemctl", ["--user", "daemon-reload"]],
					],
		);
		expect(runner.exec.mock.invocationCallOrder[1]).toBeLessThan(
			runner.removeFile.mock.invocationCallOrder[0] ?? 0,
		);
		expect(files.has(config.paths.unitFile)).toBe(false);
		expect(output).toContain("Uninstalled");
		expect(runner.checkDaemon).not.toHaveBeenCalled();
	});

	it("retains the unit if stopping fails", async () => {
		const { runner, files, config } = fakeRunner(platform);
		files.set(config.paths.unitFile, generateServiceUnit(config));
		loaded(runner, platform);
		const execute = runner.exec.getMockImplementation();
		runner.exec.mockImplementation(async (command, args) => {
			if (args.includes("bootout") || args.includes("disable"))
				return { code: 1, stdout: "", stderr: "Permission denied" };
			if (!execute) throw new Error("Missing fake execution");
			return execute(command, args);
		});
		await expect(
			runServiceCommand("uninstall", config, runner),
		).rejects.toThrow(/Permission denied/);
		expect(runner.removeFile).not.toHaveBeenCalled();
		expect(files.has(config.paths.unitFile)).toBe(true);
	});

	it("removes an installed but unloaded unit", async () => {
		const { runner, files, config } = fakeRunner(platform);
		files.set(config.paths.unitFile, generateServiceUnit(config));
		await runServiceCommand("uninstall", config, runner);
		expect(files.has(config.paths.unitFile)).toBe(false);
		if (platform === "darwin") expect(runner.exec.mock.calls).toHaveLength(1);
		else
			expect(runner.exec).toHaveBeenCalledWith("systemctl", [
				"--user",
				"disable",
				"--now",
				"conduit",
			]);
	});

	it("can stop a loaded service whose unit file is already missing", async () => {
		const { runner, config } = fakeRunner(platform);
		loaded(runner, platform);
		if (platform === "linux") {
			// Reload can leave a running process with LoadState=not-found.
			// Older systemd refuses disable --now when the unit file is missing.
			runner.exec.mockResolvedValue({
				code: 0,
				stdout:
					"LoadState=not-found\nActiveState=active\nSubState=running\nMainPID=42\n",
				stderr: "",
			});
		}
		await runServiceCommand("uninstall", config, runner);
		expect(runner.exec).toHaveBeenCalledWith(
			platform === "darwin" ? "launchctl" : "systemctl",
			platform === "darwin"
				? ["bootout", "gui/501/dev.conduit.server"]
				: ["--user", "stop", "conduit"],
		);
		expect(runner.removeFile).not.toHaveBeenCalled();
	});

	it("makes uninstall harmless when the service is absent", async () => {
		const { runner, config } = fakeRunner(platform);
		expect(await runServiceCommand("uninstall", config, runner)).toContain(
			"not installed",
		);
		expect(runner.removeFile).not.toHaveBeenCalled();
		expect(runner.exec.mock.calls).toHaveLength(1);
	});

	it("reports installed, loaded, running, pid and log paths without mutations", async () => {
		const { runner, files, config } = fakeRunner(platform);
		files.set(config.paths.unitFile, generateServiceUnit(config));
		loaded(runner, platform);
		const output = await runServiceCommand("status", config, runner);
		expect(output).toContain("Installed: yes");
		expect(output).toContain("Loaded: yes");
		expect(output).toContain("Running: yes");
		expect(output).toContain("PID: 42");
		expect(output).toContain(config.paths.stdout);
		expect(output).toContain(config.paths.stderr);
		expect(runner.writeFile).not.toHaveBeenCalled();
		expect(runner.removeFile).not.toHaveBeenCalled();
		expect(runner.checkDaemon).not.toHaveBeenCalled();
	});

	it("reports a loaded but stopped service without inventing a pid", async () => {
		const { runner, config } = fakeRunner(platform);
		loaded(runner, platform, 0);
		const output = await runServiceCommand("status", config, runner);
		expect(output).toContain("Installed: no");
		expect(output).toContain("Loaded: yes");
		expect(output).toContain("Running: no");
		expect(output).toContain("PID: none");
	});

	it("reports absence without treating it as a service-manager failure", async () => {
		const { runner, config } = fakeRunner(platform);
		const output = await runServiceCommand("status", config, runner);
		expect(output).toContain("Installed: no");
		expect(output).toContain("Loaded: no");
		expect(output).toContain("Running: no");
	});

	it("reads the installed log paths even when the current config directory differs", async () => {
		const { runner, config, files } = fakeRunner(platform);
		const installed = {
			...config,
			paths: {
				...getServicePaths(platform, homeDir, "/logs/work & 50%", cwd),
				unitFile: config.paths.unitFile,
			},
		};
		files.set(config.paths.unitFile, generateServiceUnit(installed));
		const output = await runServiceCommand("status", config, runner);
		expect(output).toContain(installed.paths.stdout);
		expect(output).toContain(installed.paths.stderr);
	});

	it.each([
		"install",
		"uninstall",
		"status",
	] as const)("surfaces manager failures during %s instead of reporting absence", async (action) => {
		const { runner, config } = fakeRunner(platform);
		runner.exec.mockResolvedValue({
			code: 1,
			stdout: "",
			stderr: "Cannot connect to service manager",
		});
		await expect(runServiceCommand(action, config, runner)).rejects.toThrow(
			/Cannot connect to service manager/,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
		expect(runner.removeFile).not.toHaveBeenCalled();
	});

	it("surfaces start failures and leaves the unit available for uninstall", async () => {
		const { runner, config, files } = fakeRunner(platform);
		const execute = runner.exec.getMockImplementation();
		runner.exec.mockImplementation(async (command, args) => {
			if (args.includes("bootstrap") || args.includes("--now"))
				return { code: 1, stdout: "", stderr: "Start failed" };
			if (!execute) throw new Error("Missing fake execution");
			return execute(command, args);
		});
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/Start failed/,
		);
		expect(files.has(config.paths.unitFile)).toBe(true);
	});

	it("does not start a service after a filesystem failure", async () => {
		const { runner, config } = fakeRunner(platform);
		runner.writeFile.mockRejectedValue(new Error("Disk full"));
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/Disk full/,
		);
		expect(runner.exec.mock.calls).toHaveLength(2);
	});
});

describe.each([
	"darwin",
	"linux",
] as const)("reviewed executable resolution on %s", (platform) => {
	it.each([
		"conduit",
		"node",
	] as const)("rejects %s available only through terminal activation", async (executable) => {
		vi.stubEnv("PATH", "/terminal/mise/bin:/terminal/nvm/bin:/usr/bin:/bin");
		vi.stubEnv("NODE_OPTIONS", "--require /terminal/only.js");
		const { runner, config } = fakeRunner(platform);
		const execute = runner.exec.getMockImplementation();
		runner.exec.mockImplementation(async (command, args, environment) => {
			if (command === config.shell) {
				const available =
					args[2]?.includes(`command -v ${executable}`) &&
					(environment ?? process.env)["PATH"]?.includes("/terminal/");
				return { code: available ? 0 : 1, stdout: "", stderr: "" };
			}
			if (!execute) throw new Error("Missing fake execution");
			return execute(command, args, environment);
		});
		await expect(runServiceCommand("install", config, runner)).rejects.toThrow(
			/node.*login shell PATH/,
		);
		expect(runner.writeFile).not.toHaveBeenCalled();
		for (const call of runner.exec.mock.calls.filter(
			([command]) => command === config.shell,
		)) {
			expect(call[2]).toMatchObject({
				HOME: homeDir,
				USER: "testuser",
				SHELL: config.shell,
			});
			expect(call[2]?.["PATH"]).not.toContain("/terminal/");
			expect(call[2]).not.toHaveProperty("NODE_OPTIONS");
		}
	});

	it("starts executable probes with the environment declared in its unit", async () => {
		const { runner, config, files } = fakeRunner(platform);
		await runServiceCommand("install", config, runner);
		const unit = files.get(config.paths.unitFile) ?? "";
		const environment = runner.exec.mock.calls.find(
			([command]) => command === config.shell,
		)?.[2];
		expect(environment).toMatchObject({
			HOME: homeDir,
			USER: "testuser",
			LOGNAME: "testuser",
			SHELL: config.shell,
			CONDUIT_CONFIG_DIR: configDir,
		});
		const path =
			platform === "darwin"
				? unit.match(/<key>PATH<\/key>\s*<string>(.*?)<\/string>/)?.[1]
				: unit.match(/^Environment="PATH=(.*?)"$/m)?.[1];
		expect(path).toBeDefined();
		expect(path).toBe(environment?.["PATH"]);
	});
});

describe("reviewed service lifecycle edge cases", () => {
	it("can install, uninstall and reinstall using a custom XDG unit lookup path", async () => {
		const { runner, config, files } = fakeRunner("linux");
		const expectedUnit = "/xdg/custom config/systemd/user/conduit.service";
		config.paths = getServicePaths(
			"linux",
			homeDir,
			configDir,
			cwd,
			"/xdg/custom config",
		);
		let running = false;
		runner.exec.mockImplementation(async (command, args) => {
			if (command === "systemctl") {
				if (args[1] === "show")
					return running
						? {
								code: 0,
								stdout:
									"LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\n",
								stderr: "",
							}
						: absentSystemd;
				if (args[1] === "enable" || args[1] === "disable") {
					if (!files.has(expectedUnit))
						return {
							code: 1,
							stdout: "",
							stderr: "Unit conduit.service not found in XDG lookup path",
						};
					running = args[1] === "enable";
				}
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		await runServiceCommand("install", config, runner);
		expect(running).toBe(true);
		await runServiceCommand("uninstall", config, runner);
		expect(running).toBe(false);
		expect(files.has(expectedUnit)).toBe(false);
		await runServiceCommand("install", config, runner);
		expect(running).toBe(true);
	});

	it.each([
		"status",
		"uninstall",
	] as const)("treats an absent GUI domain as unloaded during %s", async (action) => {
		const { runner, config, files } = fakeRunner("darwin");
		files.set(config.paths.unitFile, generateServiceUnit(config));
		runner.exec.mockResolvedValue({
			code: 113,
			stdout: "",
			stderr: "Could not find domain for user gui: 501",
		});
		const output = await runServiceCommand(action, config, runner);
		if (action === "status") {
			expect(output).toContain("Installed: yes");
			expect(output).toContain("Loaded: no");
			expect(output).toContain("Running: no");
			expect(files.has(config.paths.unitFile)).toBe(true);
		} else {
			expect(output).toContain("Uninstalled");
			expect(files.has(config.paths.unitFile)).toBe(false);
		}
		expect(runner.exec).toHaveBeenCalledOnce();
	});

	it.each([
		["status", " "],
		["status", "\\"],
		["uninstall", " "],
		["uninstall", "\\"],
	] as const)("does not generate a unit during %s from a directory ending in %j", async (action, suffix) => {
		const { runner, config, files } = fakeRunner("linux");
		files.set(config.paths.unitFile, generateServiceUnit(config));
		loaded(runner, "linux");
		config.paths.workingDirectory = `${cwd}${suffix}`;
		const output = await runServiceCommand(action, config, runner);
		expect(output).toContain(
			action === "status" ? "Running: yes" : "Uninstalled",
		);
		expect(runner.exec).toHaveBeenCalled();
	});

	it.each([
		"status",
		"uninstall",
	] as const)("ignores the current launch command during %s", async (action) => {
		const { runner, config, files } = fakeRunner("linux");
		files.set(config.paths.unitFile, generateServiceUnit(config));
		loaded(runner, "linux");
		config.shell = "relative-shell";
		config.command = [];
		const output = await runServiceCommand(action, config, runner);
		expect(output).toContain(
			action === "status" ? "Running: yes" : "Uninstalled",
		);
	});

	it("forwards the isolated probe environment to the child process", () => {
		vi.stubEnv("PATH", "/terminal/mise/bin:/usr/bin:/bin");
		const execute = vi
			.mocked(childProcess.execFile)
			.mockReturnValueOnce(new childProcess.ChildProcess());
		const environment = {
			HOME: homeDir,
			PATH: "/usr/bin:/bin",
			SHELL: "/fake/login-shell",
		};
		// The mocked child is never spawned; this assertion checks the runner's boundary.
		void service
			.createServiceRunner(async () => false)
			.exec(
				"/fake/login-shell",
				["-l", "-c", "command -v conduit"],
				environment,
			);
		expect(execute).toHaveBeenCalledWith(
			"/fake/login-shell",
			["-l", "-c", "command -v conduit"],
			expect.objectContaining({ env: environment }),
			expect.any(Function),
		);
	});
});

describe("service CLI route", () => {
	it.each([
		"install",
		"uninstall",
		"status",
		"invalid",
	])("parses the service %s subcommand", (action) => {
		expect(parseArgs(["service", action, "--port", "7777"])).toMatchObject({
			command: "service",
			serviceAction: action,
			port: 7777,
		});
	});

	it("keeps service --help on the ordinary help route", () => {
		expect(parseArgs(["service", "--help"]).command).toBe("help");
	});

	it("routes service to its handler without starting a daemon or sending IPC", async () => {
		const handler = vi
			.spyOn(service, "handleService")
			.mockResolvedValue(undefined);
		const checkDaemon = vi.fn(async () => false);
		const sendRPC = vi.fn();
		const spawnDaemon = vi.fn();
		await run(["service", "install", "--port", "7777"], {
			cwd,
			isDaemonRunning: checkDaemon,
			sendRPC,
			spawnDaemon,
		});
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.objectContaining({ serviceAction: "install", port: 7777 }),
				cwd,
				checkDaemon,
			}),
		);
		expect(checkDaemon).not.toHaveBeenCalled();
		expect(sendRPC).not.toHaveBeenCalled();
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		"invalid",
	])("prints usage for action %s before any effects", async (action) => {
		const { runner } = fakeRunner("darwin");
		const stderr = { write: vi.fn() };
		const exit = vi.fn();
		await handleService(
			{
				args: parseArgs(["service", ...(action ? [action] : [])]),
				cwd,
				stdout: { write: vi.fn() },
				stderr,
				exit,
				checkDaemon: runner.checkDaemon,
			},
			runner,
		);
		expect(stderr.write).toHaveBeenCalledWith(
			expect.stringContaining("conduit service install | uninstall | status"),
		);
		expect(exit).toHaveBeenCalledWith(1);
		expect(runner.exec).not.toHaveBeenCalled();
	});
});
