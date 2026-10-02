import { AddProject, GetStatus } from "../lib/contracts/ws-rpc.js";
import { isDaemonSpawnPortInUseError } from "../lib/daemon/daemon-spawn.js";
import { formatErrorDetail } from "../lib/errors.js";
import type { CommandContext } from "./cli-command-handlers.js";
import { defaultInteractiveMenu } from "./cli-commands.js";

export async function handleDefault(ctx: CommandContext): Promise<void> {
	const {
		args,
		options,
		cwd,
		stdout,
		stderr,
		exit,
		rpcSend,
		checkDaemon,
		spawnDaemonFn,
		getAddr,
		getTsIP,
		qr,
	} = ctx;

	if (args.skipPerms && !args.pin) {
		stderr.write("--dangerously-skip-permissions requires --pin\n");
		exit(1);
		return;
	}

	const stdin = options?.stdin ?? process.stdin;

	// Determine if interactive mode should be used:
	// - Explicit injectable overrides everything
	// - stdin being a TTY means real terminal → interactive
	// - Non-TTY (pipe, test, CI) → legacy non-interactive behavior
	if (options?.showInteractiveMenu || (stdin as { isTTY?: boolean }).isTTY) {
		const interactiveMenu =
			options?.showInteractiveMenu ?? defaultInteractiveMenu;

		await interactiveMenu({
			args,
			cwd,
			stdin,
			stdout,
			stderr,
			exit,
			rpcSend,
			checkDaemon,
			spawnDaemon: spawnDaemonFn,
			getAddr,
			generateQR: qr,
		});
		return;
	}

	// Non-interactive default (legacy behavior)
	let running = await checkDaemon();
	if (!running) {
		try {
			const result = await spawnDaemonFn({
				port: args.port,
				opencodeUrl: `http://localhost:${args.ocPort}`,
			});
			stdout.write(
				`Daemon started (pid: ${result.pid}, port: ${result.port})\n`,
			);
			running = true;
		} catch (err) {
			const message = formatErrorDetail(err);
			if (isDaemonSpawnPortInUseError(err)) {
				stderr.write(`Port ${args.port} is already in use.\n`);
				stderr.write("Try a different port: --port <number>\n");
			} else {
				stderr.write(`Failed to start daemon: ${message}\n`);
			}
			exit(1);
			return;
		}
	}

	let slug: string | undefined;
	try {
		const registerResponse = await rpcSend(new AddProject({ directory: cwd }));
		slug = registerResponse.addedSlug;
	} catch {
		// The default view remains available when project registration fails.
	}

	const statusResponse = await rpcSend(new GetStatus({}));
	const scheme = statusResponse["tlsEnabled"] === true ? "https" : "http";
	// 3b. Build URLs with Tailscale priority (consistent with interactive path)
	const tsIP = getTsIP();
	const lanIP = getAddr();
	const primaryIP = tsIP ?? lanIP ?? "localhost";
	const url = `${scheme}://${primaryIP}:${args.port}`;
	const tlsActive = statusResponse["tlsEnabled"] === true;

	if (primaryIP !== "localhost") {
		const qrUrl = tlsActive
			? `http://${primaryIP}:${args.port + 1}/setup`
			: url;
		const qrCode = qr(qrUrl);
		if (qrCode) {
			stdout.write("\n");
			stdout.write(qrCode);
			if (tlsActive) {
				stdout.write(
					`  Scan or visit: http://${primaryIP}:${args.port + 1}/setup\n`,
				);
			}
			stdout.write("\n");
		}
	}

	stdout.write("\n");
	stdout.write("conduit\n");
	stdout.write(`  URL: ${url}\n`);
	if (tsIP && lanIP && tsIP !== lanIP) {
		stdout.write(`  Local: ${scheme}://${lanIP}:${args.port}\n`);
	}

	if (slug) {
		stdout.write(`  Project: ${slug} (${cwd})\n`);
	}

	stdout.write("Tip: Set a PIN for security: conduit --pin <4-8 digits>\n");
	stdout.write("\n");
}
