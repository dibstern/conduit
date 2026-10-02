// Individual CLI command implementations: interactive menu, main menu launcher.

import { spawn as cpSpawn } from "node:child_process";
import { join } from "node:path";
import { hashPin } from "../lib/auth.js";
import { type DaemonInfo, showMainMenu } from "../lib/cli/cli-menu.js";
import { showNotificationWizard } from "../lib/cli/cli-notifications.js";
import { showProjectsMenu } from "../lib/cli/cli-projects.js";
import { showSettingsMenu } from "../lib/cli/cli-settings.js";
import { runSetup } from "../lib/cli/cli-setup.js";
import { getTailscaleIP, hasMkcert } from "../lib/cli/tls.js";
import {
	AddProject,
	GetProjects,
	GetStatus,
	RemoveProject,
	RenameProject,
	SetKeepAwake,
	SetKeepAwakeCommand,
	SetPin,
	Shutdown,
} from "../lib/contracts/ws-rpc.js";
import { isDaemonSpawnPortInUseError } from "../lib/daemon/daemon-spawn.js";
import { DEFAULT_CONFIG_DIR } from "../lib/env.js";
import { formatErrorDetail } from "../lib/errors.js";
import { getVersion } from "../lib/version.js";

import type { InteractiveContext } from "./cli-core.js";

/**
 * The default interactive menu flow.
 *
 * 1. No daemon running → first-run setup wizard → fork daemon → main menu
 * 2. Daemon running → auto-add cwd → main menu
 */
export async function defaultInteractiveMenu(
	ctx: InteractiveContext,
): Promise<void> {
	const {
		args,
		cwd,
		stdin,
		stdout,
		stderr,
		exit,
		rpcSend,
		checkDaemon,
		spawnDaemon,
	} = ctx;

	const running = await checkDaemon();

	if (!running) {
		// First-run setup wizard
		const setupResult = await runSetup({
			stdin,
			stdout,
			exit,
		});

		// Fork daemon with setup results
		try {
			const daemonResult = await spawnDaemon({
				port: setupResult.port,
				...(setupResult.pin && {
					pinHash: hashPin(setupResult.pin),
				}),
				keepAwake: setupResult.keepAwake,
				opencodeUrl: `http://localhost:${args.ocPort}`,
			});
			stdout.write(
				`Daemon started (pid: ${daemonResult.pid}, port: ${daemonResult.port})\n`,
			);

			// Register restored projects
			for (const proj of setupResult.restoredProjects) {
				await menuResult(rpcSend(new AddProject({ directory: proj.path })));
			}
		} catch (err) {
			const message = formatErrorDetail(err);
			if (isDaemonSpawnPortInUseError(err)) {
				stderr.write(`Port ${setupResult.port} is already in use.\n`);
				stderr.write("Try a different port: --port <number>\n");
			} else {
				stderr.write(`Failed to start daemon: ${message}\n`);
			}
			exit(1);
			return;
		}

		// Register cwd
		await menuResult(rpcSend(new AddProject({ directory: cwd })));

		// Show main menu
		await launchMainMenu(ctx, setupResult.port);
	} else {
		// Daemon already running — auto-add cwd, then show main menu
		await menuResult(rpcSend(new AddProject({ directory: cwd })));
		await launchMainMenu(ctx, args.port);
	}
}

async function menuResult(
	operation: Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
	try {
		await operation;
		return { ok: true };
	} catch (err) {
		return { ok: false, error: formatErrorDetail(err) };
	}
}

/**
 * Open a URL in the system default browser.
 * Uses platform-appropriate command: open (macOS), xdg-open (Linux), cmd (Windows).
 */
function openUrl(url: string): void {
	try {
		if (process.platform === "win32") {
			cpSpawn("cmd", ["/c", "start", "", url], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			}).unref();
		} else {
			const cmd = process.platform === "darwin" ? "open" : "xdg-open";
			cpSpawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
		}
	} catch {
		// Silently ignore errors (e.g., no browser available)
	}
}

/**
 * Launch the interactive main menu with all callbacks wired.
 */
async function launchMainMenu(
	ctx: InteractiveContext,
	port: number,
): Promise<void> {
	const { cwd, stdin, stdout, exit, rpcSend, getAddr, generateQR: qr } = ctx;

	const buildDaemonInfo = async (): Promise<DaemonInfo> => {
		const status = await rpcSend(new GetStatus({}));
		const tls = status["tlsEnabled"] === true;
		const scheme = tls ? "https" : "http";
		// Prefer Tailscale IP if available, then LAN IP, then localhost
		const tsIP = getTailscaleIP();
		const lanIP = getAddr();
		const ip = tsIP ?? lanIP ?? "localhost";
		const url = `${scheme}://${ip}:${port}`;
		// Build network URLs for display (show both Tailscale and LAN if available)
		const networkUrls: string[] = [];
		if (tsIP && lanIP && tsIP !== lanIP) {
			networkUrls.push(`${scheme}://${lanIP}:${port}`);
		}
		return {
			port: typeof status.port === "number" ? status.port : port,
			url,
			networkUrls,
			projectCount:
				typeof status.projectCount === "number" ? status.projectCount : 0,
			sessionCount:
				typeof status["sessionCount"] === "number" ? status["sessionCount"] : 0,
			processingCount:
				typeof status["processingCount"] === "number"
					? status["processingCount"]
					: 0,
			version: getVersion(),
			// When TLS is active, QR should point to the HTTP onboarding server
			// (port+1) so the phone installs the CA cert before accessing HTTPS.
			...(ip !== "localhost" && {
				qrCode: qr(tls ? `http://${ip}:${port + 1}/setup` : url),
			}),
			// Show onboarding setup URL when TLS is active
			...(tls &&
				ip !== "localhost" && {
					setupUrl: `http://${ip}:${port + 1}/setup`,
				}),
		};
	};

	const menuOpts = {
		stdin,
		stdout,
		exit,
		getDaemonInfo: buildDaemonInfo,
		onSetupNotifications: async () => {
			const status = await rpcSend(new GetStatus({}));
			const tlsActive = (status["tlsEnabled"] as boolean) ?? false;
			await showNotificationWizard({
				stdin,
				stdout,
				exit,
				onBack: async () => {
					/* returns to main menu via re-render */
				},
				config: { tls: tlsActive, port },
				generateQR: qr,
			});
		},
		onProjects: async () => {
			await showProjectsMenu({
				stdin,
				stdout,
				exit,
				cwd,
				getProjects: async () => {
					try {
						const res = await rpcSend(new GetProjects({}));
						return res.projects.map((p) => ({
							slug: p.slug,
							path: p.directory,
							title: p.title,
							sessions: 0,
							clients: 0,
							isProcessing: false,
						}));
					} catch {
						return [];
					}
				},
				addProject: async (directory: string) => {
					try {
						const res = await rpcSend(new AddProject({ directory }));
						return { ok: true, slug: res.addedSlug ?? directory };
					} catch (err) {
						return { ok: false, error: formatErrorDetail(err) };
					}
				},
				removeProject: async (slug: string) => {
					return menuResult(rpcSend(new RemoveProject({ slug })));
				},
				setProjectTitle: async (slug: string, title: string) => {
					return menuResult(rpcSend(new RenameProject({ slug, title })));
				},
				onBack: async () => {
					/* returns to main menu via re-render */
				},
			});
		},
		onSettings: async () => {
			await showSettingsMenu({
				stdin,
				stdout,
				exit,
				logPath: join(DEFAULT_CONFIG_DIR, "daemon.log"),
				getSettingsInfo: async () => {
					const status = await rpcSend(new GetStatus({}));
					return {
						tailscaleIP: getTailscaleIP(),
						hasMkcert: await hasMkcert(),
						tlsEnabled: (status["tlsEnabled"] as boolean) ?? false,
						pinEnabled: (status["pinEnabled"] as boolean) ?? false,
						keepAwake: (status["keepAwake"] as boolean) ?? false,
					};
				},
				setPin: async (pin: string) => {
					return menuResult(rpcSend(new SetPin({ pin })));
				},
				removePin: async () => {
					return menuResult(rpcSend(new SetPin({ pin: null })));
				},
				setKeepAwake: async (enabled: boolean) => {
					try {
						const res = await rpcSend(new SetKeepAwake({ enabled }));
						return { ok: true, supported: res.supported, active: res.active };
					} catch (err) {
						return { ok: false, error: formatErrorDetail(err) };
					}
				},
				setKeepAwakeCommand: async (command: string, args: string[]) => {
					return menuResult(
						rpcSend(new SetKeepAwakeCommand({ command, args })),
					);
				},
				onBack: async () => {
					/* returns to main menu via re-render */
				},
			});
		},
		onOpenBrowser: async () => {
			const info = await buildDaemonInfo();
			openUrl(info.url);
		},
		onShutdown: async () => {
			try {
				await rpcSend(new Shutdown({}));
			} catch {
				// Daemon already stopped or socket removed — treat as success
			}
			exit(0);
		},
		onKeepAliveExit: () => {
			exit(0);
		},
	};

	await showMainMenu(menuOpts);
}
