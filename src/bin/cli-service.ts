import { execFile } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion } from "../lib/version.js";
import type { CommandContext } from "./cli-command-handlers.js";
import { DEFAULT_CONFIG_DIR, type ParsedArgs } from "./cli-utils.js";

const LABEL = "dev.conduit.server";

export interface ServicePaths {
	unitFile: string;
	configDir: string;
	workingDirectory: string;
	stdout: string;
	stderr: string;
}

export interface ServiceOptions {
	platform: NodeJS.Platform;
	shell: string;
	command: readonly string[];
	paths: ServicePaths;
	uid: number;
	cliEntry: string;
	port: number;
	host?: string;
	environment?: Record<string, string>;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ServiceRunner {
	exec(
		command: string,
		args: string[],
		environment?: Record<string, string>,
	): Promise<CommandResult>;
	exists(path: string): Promise<boolean>;
	readFile(path: string): Promise<string>;
	mkdir(path: string): Promise<void>;
	writeFile(path: string, content: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	checkDaemon(): Promise<boolean>;
	isPortAvailable(port: number, host: string): Promise<boolean>;
}

export function getServicePaths(
	platform: NodeJS.Platform,
	homeDir: string,
	configDir: string,
	workingDirectory: string,
	xdgConfigHome?: string,
): ServicePaths {
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error("Conduit services are supported on macOS and Linux only.");
	}
	return {
		unitFile:
			platform === "darwin"
				? join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`)
				: join(
						xdgConfigHome || join(homeDir, ".config"),
						"systemd",
						"user",
						"conduit.service",
					),
		configDir,
		workingDirectory,
		stdout: join(configDir, "service.stdout.log"),
		stderr: join(configDir, "service.stderr.log"),
	};
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function shellArgument(value: string): string {
	return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'"'"'`)}'`;
}

function systemdArgument(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function serviceEnvironment(
	options: Pick<ServiceOptions, "paths" | "environment">,
): Record<string, string> {
	return {
		...options.environment,
		PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
		CONDUIT_CONFIG_DIR: options.paths.configDir,
		LC_ALL: "C",
	};
}

export function generateServiceUnit(
	options: Pick<
		ServiceOptions,
		"platform" | "shell" | "command" | "paths" | "environment"
	>,
): string {
	const { platform, shell, command, paths } = options;
	const environment = serviceEnvironment(options);
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error("Conduit services are supported on macOS and Linux only.");
	}
	if (!isAbsolute(shell)) {
		throw new Error("The login shell must be an absolute path. Set SHELL.");
	}
	if (!command.length || !command[0]) {
		throw new Error("A service command is required.");
	}
	for (const value of [
		shell,
		...command,
		...Object.values(paths),
		...Object.values(environment),
	]) {
		if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
			throw new Error(
				"Service arguments and paths cannot contain control characters or newlines.",
			);
		}
	}
	const script = `exec ${command.map(shellArgument).join(" ")}`;
	if (platform === "darwin") {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(shell)}</string>
    <string>-l</string>
    <string>-c</string>
    <string>${xml(script)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${xml(paths.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
	.map(
		([key, value]) =>
			`    <key>${xml(key)}</key><string>${xml(value)}</string>`,
	)
	.join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>
</dict>
</plist>
`;
	}
	// Path directives take literal paths, not quoted command-line arguments.
	// A trailing backslash or whitespace would be consumed by the unit parser.
	for (const path of [paths.workingDirectory, paths.stdout, paths.stderr]) {
		if (path.endsWith("\\") || path !== path.trimEnd()) {
			throw new Error(
				"Systemd service paths cannot end in backslashes or whitespace.",
			);
		}
	}
	return `[Unit]
Description=Conduit server

[Service]
Type=simple
WorkingDirectory=${paths.workingDirectory.replaceAll("%", "%%")}
${Object.entries(environment)
	.map(([key, value]) => `Environment=${systemdArgument(`${key}=${value}`)}`)
	.join("\n")}
ExecStart=${systemdArgument(shell)} -l -c ${systemdArgument(script.replaceAll("$", () => "$$"))}
Restart=always
RestartSec=5
StandardOutput=append:${paths.stdout.replaceAll("%", "%%")}
StandardError=append:${paths.stderr.replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`;
}

export function foregroundArguments(args: ParsedArgs): string[] {
	const flags = [
		"serve",
		"--port",
		String(args.port),
		"--oc-port",
		String(args.ocPort),
		"--log-level",
		args.logLevel,
	];
	if (args.host) flags.push("--host", args.host);
	if (args.claudeConfigDir)
		flags.push("--claude-config-dir", args.claudeConfigDir);
	if (args.noHttps) flags.push("--no-https");
	if (args.logFormat) flags.push("--log-format", args.logFormat);
	return flags;
}

async function checkedExec(
	runner: ServiceRunner,
	command: string,
	args: string[],
): Promise<void> {
	const result = await runner.exec(command, args);
	if (result.code !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
		);
	}
}

async function serviceState(options: ServiceOptions, runner: ServiceRunner) {
	const { platform, paths, uid } = options;
	const installed = await runner.exists(paths.unitFile);
	let stdout = paths.stdout;
	let stderr = paths.stderr;
	if (installed) {
		const unit = await runner.readFile(paths.unitFile);
		if (platform === "darwin") {
			const value = (key: string) =>
				unit
					.match(new RegExp(`<key>${key}</key>\\s*<string>(.*?)</string>`))?.[1]
					?.replaceAll("&apos;", "'")
					.replaceAll("&quot;", '"')
					.replaceAll("&gt;", ">")
					.replaceAll("&lt;", "<")
					.replaceAll("&amp;", "&");
			stdout = value("StandardOutPath") ?? stdout;
			stderr = value("StandardErrorPath") ?? stderr;
		} else {
			stdout =
				unit
					.match(/^StandardOutput=append:(.*)$/m)?.[1]
					?.replaceAll("%%", "%") ?? stdout;
			stderr =
				unit
					.match(/^StandardError=append:(.*)$/m)?.[1]
					?.replaceAll("%%", "%") ?? stderr;
		}
	}
	const result = await runner.exec(
		platform === "darwin" ? "launchctl" : "systemctl",
		platform === "darwin"
			? ["print", `gui/${uid}/${LABEL}`]
			: [
					"--user",
					"show",
					"conduit",
					"--property=LoadState,ActiveState,SubState,MainPID",
				],
	);
	let loaded = false;
	let pid: number | undefined;
	if (platform === "darwin") {
		if (result.code === 0) {
			loaded = true;
			pid = Number(result.stdout.match(/^\s*pid = (\d+)/m)?.[1]) || undefined;
		} else if (
			!/could not find (?:specified )?service|could not find domain for user gui:|no such process/i.test(
				result.stderr,
			)
		) {
			throw new Error(
				`launchctl print failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			);
		}
	} else {
		const loadState = result.stdout.match(/^LoadState=(.*)$/m)?.[1];
		if ((result.code !== 0 && loadState !== "not-found") || !loadState) {
			throw new Error(
				`systemctl --user show failed: ${result.stderr.trim() || `exit ${result.code}, no LoadState`}`,
			);
		}
		loaded = loadState === "loaded";
		pid = Number(result.stdout.match(/^MainPID=(\d+)/m)?.[1]) || undefined;
	}
	return { installed, loaded, running: pid !== undefined, pid, stdout, stderr };
}

export async function runServiceCommand(
	action: "install" | "uninstall" | "status",
	options: ServiceOptions,
	runner: ServiceRunner,
): Promise<string> {
	const { platform, paths, uid } = options;
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error("Conduit services are supported on macOS and Linux only.");
	}
	const state = await serviceState(options, runner);
	const target = `gui/${uid}/${LABEL}`;
	const logs = `  Stdout: ${state.stdout}\n  Stderr: ${state.stderr}\n`;
	if (action === "status") {
		return `Conduit service\n  Installed: ${state.installed ? "yes" : "no"}\n  Loaded: ${state.loaded ? "yes" : "no"}\n  Running: ${state.running ? "yes" : "no"}\n  PID: ${state.pid ?? "none"}\n  Unit: ${paths.unitFile}\n${logs}`;
	}
	if (action === "uninstall") {
		if (!state.installed && !state.loaded && !state.running)
			return "Conduit service is not installed.\n";
		if (platform === "darwin") {
			if (state.loaded)
				await checkedExec(runner, "launchctl", ["bootout", target]);
		} else if (state.installed) {
			await checkedExec(runner, "systemctl", [
				"--user",
				"disable",
				"--now",
				"conduit",
			]);
		} else {
			await checkedExec(runner, "systemctl", ["--user", "stop", "conduit"]);
		}
		if (state.installed) await runner.removeFile(paths.unitFile);
		if (platform === "linux")
			await checkedExec(runner, "systemctl", ["--user", "daemon-reload"]);
		return `Uninstalled Conduit service. Logs retained.\n${logs}`;
	}
	let unit = generateServiceUnit(options);
	if (state.installed || state.loaded || state.running) {
		throw new Error(
			"Conduit service is already installed or loaded. Run conduit service uninstall before reinstalling.",
		);
	}
	if (await runner.checkDaemon()) {
		throw new Error(
			"A Conduit daemon is already running. Stop it first with conduit --stop, then install the service.",
		);
	}
	if (
		!(await runner.isPortAvailable(options.port, options.host ?? "0.0.0.0"))
	) {
		throw new Error(
			`Port ${options.port} is already in use. Stop the existing server before installing the service.`,
		);
	}
	let warning = "";
	const environment = serviceEnvironment(options);
	const found = await runner.exec(
		options.shell,
		["-l", "-c", "command -v conduit >/dev/null 2>&1"],
		environment,
	);
	if (found.code !== 0) {
		// npm can delete its npx cache at any time, so a service pointing into it
		// breaks at a later login. Let npx re-fetch this exact version instead.
		const viaNpx = options.cliEntry.includes(`${sep}_npx${sep}`);
		const launcher = viaNpx ? "npx" : "node";
		if (!viaNpx && !(await runner.exists(options.cliEntry))) {
			throw new Error(
				`Conduit is absent from the login shell PATH and the installed CLI entry is missing: ${options.cliEntry}. Install conduit-code first.`,
			);
		}
		const probe = await runner.exec(
			options.shell,
			["-l", "-c", `command -v ${launcher} >/dev/null 2>&1`],
			environment,
		);
		if (probe.code !== 0)
			throw new Error(
				`Neither conduit nor ${launcher} is available on the login shell PATH.`,
			);
		const npxPackage = `conduit-code@${getVersion()}`;
		unit = generateServiceUnit({
			...options,
			command: [
				...(viaNpx ? ["npx", "--yes", npxPackage] : ["node", options.cliEntry]),
				...options.command.slice(1),
			],
		});
		warning = viaNpx
			? `Note: conduit is not installed globally, so the service runs npx --yes ${npxPackage}. npx downloads it again if npm's cache is cleared.\n`
			: `Warning: conduit is not on the login shell PATH; using node ${options.cliEntry}. Node is resolved through the login shell PATH.\n`;
	}
	await runner.mkdir(dirname(paths.unitFile));
	await runner.mkdir(paths.configDir);
	await runner.writeFile(paths.unitFile, unit);
	if (platform === "darwin") {
		await checkedExec(runner, "launchctl", ["enable", target]);
		await checkedExec(runner, "launchctl", [
			"bootstrap",
			`gui/${uid}`,
			paths.unitFile,
		]);
	} else {
		await checkedExec(runner, "systemctl", ["--user", "daemon-reload"]);
		await checkedExec(runner, "systemctl", [
			"--user",
			"enable",
			"--now",
			"conduit",
		]);
	}
	return `${warning}Installed Conduit service. Run conduit service status to check it.\n  Unit: ${paths.unitFile}\n${logs}`;
}

export function createServiceRunner(
	checkDaemon: ServiceRunner["checkDaemon"],
): ServiceRunner {
	return {
		exec: (command, args, environment) =>
			new Promise((fulfil, reject) => {
				execFile(
					command,
					args,
					{
						encoding: "utf8",
						timeout: 15_000,
						maxBuffer: 1024 * 1024,
						env: environment ?? { ...process.env, LC_ALL: "C" },
					},
					(error, stdout, stderr) => {
						if (!error) fulfil({ code: 0, stdout, stderr });
						else if (typeof error.code === "number")
							fulfil({ code: error.code, stdout, stderr });
						else reject(error);
					},
				);
			}),
		exists: async (path) => {
			try {
				await access(path);
				return true;
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return false;
				throw error;
			}
		},
		readFile: (path) => readFile(path, "utf8"),
		mkdir: async (path) => {
			await mkdir(path, { recursive: true });
		},
		writeFile: async (path, content) => {
			await writeFile(path, content, {
				encoding: "utf8",
				mode: 0o644,
				flag: "wx",
			});
		},
		removeFile: (path) => unlink(path),
		checkDaemon,
		isPortAvailable: (port, host) =>
			new Promise((fulfil, reject) => {
				const server = createServer();
				server.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "EADDRINUSE") fulfil(false);
					else reject(error);
				});
				server.listen(port, host, () => server.close(() => fulfil(true)));
			}),
	};
}

export async function handleService(
	ctx: Pick<
		CommandContext,
		"args" | "cwd" | "stdout" | "stderr" | "exit" | "checkDaemon"
	>,
	runner: ServiceRunner = createServiceRunner(ctx.checkDaemon),
): Promise<void> {
	const action = ctx.args.serviceAction;
	if (action !== "install" && action !== "uninstall" && action !== "status") {
		ctx.stderr.write(
			"Usage: conduit service install | uninstall | status [server options]\n",
		);
		ctx.exit(1);
		return;
	}
	try {
		const configDir = resolve(DEFAULT_CONFIG_DIR);
		const homeDir = homedir();
		const user = userInfo();
		const shell = process.env["SHELL"] || user.shell || "/bin/sh";
		const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
		const paths = getServicePaths(
			process.platform,
			homeDir,
			configDir,
			resolve(ctx.cwd),
			xdgConfigHome,
		);
		const output = await runServiceCommand(
			action,
			{
				platform: process.platform,
				shell,
				command: ["conduit", ...foregroundArguments(ctx.args)],
				paths,
				uid: process.getuid?.() ?? 0,
				cliEntry: fileURLToPath(new URL("./cli.js", import.meta.url)),
				port: ctx.args.port,
				...(ctx.args.host ? { host: ctx.args.host } : {}),
				environment: {
					HOME: homeDir,
					USER: user.username,
					LOGNAME: user.username,
					SHELL: shell,
					...(xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigHome } : {}),
				},
			},
			runner,
		);
		ctx.stdout.write(output);
	} catch (error) {
		ctx.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		ctx.exit(1);
	}
}
