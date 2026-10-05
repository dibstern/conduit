// CLI command handlers. Keep command output and failure paths local to each handler.

import { resolve } from "node:path";
import type { Request } from "effect/Request";
import {
	GetProjects,
	GetStatus,
	RemoveProject,
	SaveProject,
	SetPin,
	Shutdown,
} from "../lib/contracts/ws-rpc.js";
import type { SendRPC } from "../lib/daemon/daemon-rpc-client.js";
import { ENV } from "../lib/env.js";
import { formatErrorDetail } from "../lib/errors.js";
import type { CLIOptions } from "./cli-core.js";
import {
	DEFAULT_PORT,
	formatUptime,
	HELP_TEXT,
	type ParsedArgs,
} from "./cli-utils.js";

export interface CommandContext {
	args: ParsedArgs;
	options: CLIOptions | undefined;
	cwd: string;
	stdout: { write(s: string): void };
	stderr: { write(s: string): void };
	exit: (code: number) => void;
	rpcSend: SendRPC;
	checkDaemon: () => Promise<boolean>;
	startForegroundDaemonFn: NonNullable<CLIOptions["startForegroundDaemon"]>;
	qr: NonNullable<CLIOptions["generateQR"]>;
	getAddr: NonNullable<CLIOptions["getNetworkAddress"]>;
	getTsIP: NonNullable<CLIOptions["getTailscaleIP"]>;
}

export async function handleServe(
	ctx: CommandContext,
	onReady?: () => Promise<void>,
): Promise<void> {
	const { args, options, stdout, stderr, exit, startForegroundDaemonFn } = ctx;
	const opencodeUrl = ENV.opencodeUrl || `http://localhost:${args.ocPort}`;

	try {
		const daemon = await startForegroundDaemonFn({
			...(args.portExplicit ? { port: args.port } : {}),
			...(args.host ? { host: args.host } : {}),
			...(options?.configDir ? { configDir: options.configDir } : {}),
			...(args.claudeConfigDir
				? { claudeConfigDir: args.claudeConfigDir }
				: {}),
			opencodeUrl,
			tlsEnabled: !args.noHttps,
			...(args.tailscaleServe !== undefined && {
				tailscaleServe: args.tailscaleServe,
			}),
			logLevel: args.logLevel,
			logFormat: args.logFormat ?? "pretty",
		});

		const status = daemon.getStatus();
		const scheme = status.tlsEnabled ? "https" : "http";
		const tailscale = status.tailscaleServe;
		const url =
			tailscale && "url" in tailscale
				? tailscale.url
				: `${scheme}://${status.host ?? "localhost"}:${daemon.port}`;
		stdout.write("\nConduit (foreground)\n");
		stdout.write(`  OpenCode: ${opencodeUrl}\n`);
		stdout.write(`  Relay:    ${url}\n`);
		if (tailscale && "url" in tailscale) {
			const code = ctx.qr(tailscale.url);
			if (code) stdout.write(`\n${code}\n`);
		} else if (tailscale && "error" in tailscale) {
			stderr.write(`  Tailscale Serve: ${tailscale.error}\n`);
		} else if (ctx.getTsIP()) {
			stdout.write(
				"  Tip: Use conduit serve --tailscale-serve for trusted HTTPS on your tailnet.\n",
			);
		}
		stdout.write("  Ready.\n\n");
		await onReady?.();

		await daemon.stopped;
		exit(0);
	} catch (err) {
		stderr.write(`Server failed: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
}

export async function handleHelp(ctx: CommandContext): Promise<void> {
	const { stdout } = ctx;

	stdout.write(HELP_TEXT);
	return;
}

export async function handleStatus(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	let response: Request.Success<GetStatus>;
	try {
		response = await rpcSend(new GetStatus({}));
	} catch (err) {
		stderr.write(`Failed to get status: ${formatErrorDetail(err)}\n`);
		exit(1);
		return;
	}

	const uptime = typeof response.uptime === "number" ? response.uptime : 0;
	const port = typeof response.port === "number" ? response.port : DEFAULT_PORT;
	const projectCount =
		typeof response.projectCount === "number" ? response.projectCount : 0;
	const clientCount =
		typeof response.clientCount === "number" ? response.clientCount : 0;

	stdout.write(`Daemon Status\n`);
	stdout.write(`  Uptime:   ${formatUptime(uptime)}\n`);
	stdout.write(`  Port:     ${port}\n`);
	stdout.write(`  Projects: ${projectCount}\n`);
	stdout.write(`  Clients:  ${clientCount}\n`);
	return;
}

export async function handleStop(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stdout.write("Server is not running.\n");
		exit(0);
		return;
	}

	try {
		await rpcSend(new Shutdown({}));
		stdout.write("Server stopped.\n");
	} catch (err) {
		stderr.write(`Failed to stop daemon: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

export async function handlePin(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	if (!args.pin || !/^\d{4,8}$/.test(args.pin)) {
		stderr.write("PIN must be 4-8 digits.\n");
		exit(1);
		return;
	}

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	try {
		await rpcSend(new SetPin({ pin: args.pin }));
		stdout.write("PIN updated.\n");
	} catch (err) {
		stderr.write(`Failed to set PIN: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

export async function handleAdd(ctx: CommandContext): Promise<void> {
	const { args, cwd, stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	const addDir = resolve(args.addPath ?? cwd);

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	try {
		const { projects } = await rpcSend(new GetProjects({}));
		const existing = projects.find((project) => project.folders[0] === addDir);
		const response = await rpcSend(
			new SaveProject({
				...(existing ? { slug: existing.slug } : {}),
				folders: [addDir],
			}),
		);
		stdout.write(`Project added: ${response.savedSlug}\n`);
	} catch (err) {
		stderr.write(`Failed to add project: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

export async function handleRemove(ctx: CommandContext): Promise<void> {
	const { cwd, stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	// First, list projects to find the slug for cwd
	let listResponse: Request.Success<GetProjects>;
	try {
		listResponse = await rpcSend(new GetProjects({}));
	} catch {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}
	const match = listResponse.projects.find((p) => p.folders[0] === cwd);

	if (!match) {
		stderr.write(`Current directory is not registered: ${cwd}\n`);
		exit(1);
		return;
	}

	try {
		await rpcSend(new RemoveProject({ slug: match.slug }));
		stdout.write(`Project removed: ${match.slug}\n`);
	} catch (err) {
		stderr.write(`Failed to remove project: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

export async function handleList(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	let response: Request.Success<GetProjects>;
	try {
		response = await rpcSend(new GetProjects({}));
	} catch {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}
	const projects = response.projects;

	if (projects.length === 0) {
		stdout.write("No projects registered.\n");
		return;
	}

	stdout.write(`Projects (${projects.length}):\n`);
	for (const p of projects) {
		const label = p.title ? `${p.slug} (${p.title})` : p.slug;
		stdout.write(`  ${label}\n    ${p.folders[0]}\n`);
	}
	return;
}

export async function handleTitle(ctx: CommandContext): Promise<void> {
	const { args, cwd, stdout, stderr, exit, checkDaemon, rpcSend } = ctx;

	if (!args.title) {
		stderr.write("Title is required. Usage: --title <name>\n");
		exit(1);
		return;
	}

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	// Find slug for cwd
	let listResponse: Request.Success<GetProjects>;
	try {
		listResponse = await rpcSend(new GetProjects({}));
	} catch {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}
	const match = listResponse.projects.find(
		(project) => project.folders[0] === resolve(cwd),
	);

	if (!match) {
		stderr.write(`Current directory is not registered: ${cwd}\n`);
		exit(1);
		return;
	}

	try {
		await rpcSend(
			new SaveProject({
				slug: match.slug,
				title: args.title,
				folders: match.folders,
			}),
		);
		stdout.write(`Title updated: ${args.title}\n`);
	} catch (err) {
		stderr.write(`Failed to set title: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}
