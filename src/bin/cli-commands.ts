// ─── CLI Commands ───────────────────────────────────────────────────────────
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
import { DEFAULT_CONFIG_DIR } from "../lib/env.js";
import { formatErrorDetail } from "../lib/errors.js";

import type { InteractiveContext } from "./cli-core.js";

// ─── Default Interactive Menu ────────────────────────────────────────────────

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
		ipcSend,
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
				await ipcSend({ cmd: "add_project", directory: proj.path });
			}
		} catch (err) {
			const message = formatErrorDetail(err);
			if (
				message.includes("EADDRINUSE") ||
				message.includes("address already in use")
			) {
				stderr.write(`Port ${setupResult.port} is already in use.\n`);
				stderr.write("Try a different port: --port <number>\n");
			} else {
				stderr.write(`Failed to start daemon: ${message}\n`);
			}
			exit(1);
			return;
		}

		// Register cwd
		await ipcSend({ cmd: "add_project", directory: cwd });

		// Show main menu
		await launchMainMenu(ctx, setupResult.port);
	} else {
		// Daemon already running — auto-add cwd, then show main menu
		await ipcSend({ cmd: "add_project", directory: cwd });
		await launchMainMenu(ctx, args.port);
	}
}

// ─── Open URL ───────────────────────────────────────────────────────────────

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

// ─── Launch Main Menu ───────────────────────────────────────────────────────

/**
 * Launch the interactive main menu with all callbacks wired.
 */
async function launchMainMenu(
	ctx: InteractiveContext,
	port: number,
): Promise<void> {
	const { cwd, stdin, stdout, exit, ipcSend, getAddr, generateQR: qr } = ctx;

	const buildDaemonInfo = async (): Promise<DaemonInfo> => {
		const status = await ipcSend({ cmd: "get_status" });
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
			version: "0.1.0",
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
			const status = await ipcSend({ cmd: "get_status" });
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
					const res = await ipcSend({ cmd: "list_projects" });
					if (!res.ok || !Array.isArray(res.projects)) return [];
					return (
						res.projects as Array<{
							slug: string;
							directory: string;
							title?: string;
							sessions?: number;
							clients?: number;
							isProcessing?: boolean;
						}>
					).map((p) => ({
						slug: p.slug,
						path: p.directory,
						...(p.title != null && { title: p.title }),
						sessions: p.sessions ?? 0,
						clients: p.clients ?? 0,
						isProcessing: p.isProcessing ?? false,
					}));
				},
				addProject: async (directory: string) => {
					const res = await ipcSend({ cmd: "add_project", directory });
					const slug = res.slug as string | undefined;
					const error = res.error as string | undefined;
					return {
						ok: res.ok,
						...(slug != null && { slug }),
						...(error != null && { error }),
					};
				},
				removeProject: async (slug: string) => {
					const res = await ipcSend({ cmd: "remove_project", slug });
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
				},
				setProjectTitle: async (slug: string, title: string) => {
					const res = await ipcSend({
						cmd: "set_project_title",
						slug,
						title,
					});
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
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
					const status = await ipcSend({ cmd: "get_status" });
					return {
						tailscaleIP: getTailscaleIP(),
						hasMkcert: await hasMkcert(),
						tlsEnabled: (status["tlsEnabled"] as boolean) ?? false,
						pinEnabled: (status["pinEnabled"] as boolean) ?? false,
						keepAwake: (status["keepAwake"] as boolean) ?? false,
					};
				},
				setPin: async (pin: string) => {
					const res = await ipcSend({ cmd: "set_pin", pin });
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
				},
				removePin: async () => {
					const res = await ipcSend({ cmd: "set_pin", pin: "" });
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
				},
				setKeepAwake: async (enabled: boolean) => {
					const res = await ipcSend({
						cmd: "set_keep_awake",
						enabled,
					});
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
				},
				setKeepAwakeCommand: async (command: string, args: string[]) => {
					const res = await ipcSend({
						cmd: "set_keep_awake_command",
						command,
						args,
					});
					const error = res.error as string | undefined;
					return { ok: res.ok, ...(error != null && { error }) };
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
				await ipcSend({ cmd: "shutdown" });
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
