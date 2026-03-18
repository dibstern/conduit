// ─── Notifications Setup Wizard (Ticket 8.14) ─────────────────────────────────
// Interactive CLI wizard for configuring push notifications and remote access.
// Two-toggle flow → conditional Tailscale/HTTPS/QR sections. Ported from
// claude-relay/bin/cli.js lines 1684-1851 (showSetupGuide).

import { printLogo } from "./cli-setup.js";
import type { PromptOptions, SelectPromptOptions } from "./prompts.js";
import { promptSelect, promptToggle } from "./prompts.js";
import { a, log, sym } from "./terminal-render.js";
import * as tls from "./tls.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationWizardOptions extends PromptOptions {
	/** Callback: return to previous menu */
	onBack: () => void | Promise<void>;
	/** Detect Tailscale IP */
	getTailscaleIP?: () => string | null;
	/** Detect mkcert */
	hasMkcert?: () => boolean;
	/** Get all LAN IPs */
	getAllIPs?: () => string[];
	/** Current config state */
	config: {
		tls: boolean;
		port: number;
	};
	/** Restart daemon with TLS */
	restartWithTLS?: () => Promise<{
		ok: boolean;
		newConfig?: { tls: boolean; port: number };
	}>;
	/** Injectable: is macOS / platform */
	platform?: string;
	/** Generate QR code art from URL (optional). */
	generateQR?: (url: string) => string;
}

// ─── showNotificationWizard ──────────────────────────────────────────────────

/**
 * Run the notifications setup wizard.
 *
 * Two-toggle flow:
 * 1. Remote access? (Tailscale)
 * 2. Push notifications? (HTTPS/mkcert)
 *
 * Then conditional sections: Tailscale, HTTPS, Setup QR.
 */
export async function showNotificationWizard(
	opts: NotificationWizardOptions,
): Promise<void> {
	const { stdout } = opts;
	const detectTailscaleIP = opts.getTailscaleIP ?? (() => tls.getTailscaleIP());
	const detectMkcert = opts.hasMkcert ?? (() => tls.hasMkcert());
	const detectAllIPs = opts.getAllIPs ?? (() => tls.getAllIPs());
	const platform = opts.platform ?? process.platform;

	// Mutable config — updated when restartWithTLS succeeds
	let config = { ...opts.config };

	const promptOpts: PromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
	};

	const selectOpts: SelectPromptOptions = {
		...promptOpts,
	};

	// Step 1: Clear screen + logo + header
	printLogo(stdout);
	log(`${sym.pointer}  ${a.bold}Setup Notifications${a.reset}`, stdout);
	log(sym.bar, stdout);

	// Step 2: Toggle 1 — Remote access
	const wantRemote = await new Promise<boolean>((resolve) => {
		promptToggle(
			"Access from outside your network?",
			"Requires Tailscale on both devices",
			false,
			resolve,
			promptOpts,
		);
	});

	log(sym.bar, stdout);

	// Step 3: Toggle 2 — Push notifications
	const wantPush = await new Promise<boolean>((resolve) => {
		promptToggle(
			"Want push notifications?",
			"Requires HTTPS (mkcert certificate)",
			false,
			resolve,
			promptOpts,
		);
	});

	log(sym.bar, stdout);

	// Step 4: Route based on selections
	if (!wantRemote && !wantPush) {
		log(
			`${sym.done}  ${a.green}All set!${a.reset}${a.dim} \u00B7 No additional setup needed.${a.reset}`,
			stdout,
		);
		log(sym.end, stdout);
		log("", stdout);
		await new Promise<void>((resolve) => {
			promptSelect(
				"Back?",
				[{ label: "Back", value: "back" }],
				() => resolve(),
				selectOpts,
			);
		});
		await opts.onBack();
		return;
	}

	if (wantRemote) {
		await renderTailscale();
	} else {
		await renderHttps();
	}

	// ─── Tailscale Section ────────────────────────────────────────────────

	async function renderTailscale(): Promise<void> {
		const tsIP = detectTailscaleIP();

		log(`${sym.pointer}  ${a.bold}Tailscale Setup${a.reset}`, stdout);

		if (tsIP) {
			log(
				`${sym.bar}  ${a.green}Tailscale is running${a.reset}${a.dim} \u00B7 ${tsIP}${a.reset}`,
				stdout,
			);
			log(sym.bar, stdout);
			log(`${sym.bar}  On your phone/tablet:`, stdout);
			log(
				`${sym.bar}  ${a.dim}1. Install Tailscale (App Store / Google Play)${a.reset}`,
				stdout,
			);
			log(
				`${sym.bar}  ${a.dim}2. Sign in with the same account${a.reset}`,
				stdout,
			);
			log(sym.bar, stdout);
			await renderHttps();
		} else {
			log(
				`${sym.bar}  ${a.yellow}Tailscale not found on this machine.${a.reset}`,
				stdout,
			);
			log(
				`${sym.bar}  ${a.dim}Install: ${a.reset}https://tailscale.com/download`,
				stdout,
			);
			log(`${sym.bar}  ${a.dim}Then run: ${a.reset}tailscale up`, stdout);
			log(sym.bar, stdout);
			log(`${sym.bar}  On your phone/tablet:`, stdout);
			log(
				`${sym.bar}  ${a.dim}1. Install Tailscale (App Store / Google Play)${a.reset}`,
				stdout,
			);
			log(
				`${sym.bar}  ${a.dim}2. Sign in with the same account${a.reset}`,
				stdout,
			);
			log(sym.bar, stdout);

			const choice = await new Promise<string | null>((resolve) => {
				promptSelect(
					"Select",
					[
						{ label: "Re-check", value: "recheck" },
						{ label: "Back", value: "back" },
					],
					resolve,
					selectOpts,
				);
			});

			if (choice === "recheck") {
				await renderTailscale();
			} else {
				await opts.onBack();
			}
		}
	}

	// ─── HTTPS Section ────────────────────────────────────────────────────

	async function renderHttps(): Promise<void> {
		if (!wantPush) {
			await showSetupQR();
			return;
		}

		const mcReady = detectMkcert();

		log(
			`${sym.pointer}  ${a.bold}HTTPS Setup (for push notifications)${a.reset}`,
			stdout,
		);

		if (mcReady) {
			log(`${sym.bar}  ${a.green}mkcert is installed${a.reset}`, stdout);

			if (!config.tls) {
				log(
					`${sym.bar}  ${a.dim}Restarting server with HTTPS...${a.reset}`,
					stdout,
				);
				if (opts.restartWithTLS) {
					const result = await opts.restartWithTLS();
					if (result.ok && result.newConfig) {
						config = { ...result.newConfig };
					}
				}
			}
			log(sym.bar, stdout);
			await showSetupQR();
		} else {
			log(`${sym.bar}  ${a.yellow}mkcert not found.${a.reset}`, stdout);

			let installHint: string;
			if (platform === "win32") {
				installHint = "choco install mkcert && mkcert -install";
			} else if (platform === "darwin") {
				installHint = "brew install mkcert && mkcert -install";
			} else {
				installHint = "apt install mkcert && mkcert -install";
			}

			log(`${sym.bar}  ${a.dim}Install: ${a.reset}${installHint}`, stdout);
			log(sym.bar, stdout);

			const choice = await new Promise<string | null>((resolve) => {
				promptSelect(
					"Select",
					[
						{ label: "Re-check", value: "recheck" },
						{ label: "Back", value: "back" },
					],
					resolve,
					selectOpts,
				);
			});

			if (choice === "recheck") {
				await renderHttps();
			} else {
				await opts.onBack();
			}
		}
	}

	// ─── Setup QR Section ─────────────────────────────────────────────────

	async function showSetupQR(): Promise<void> {
		const tsIP = detectTailscaleIP();
		let lanIP: string | null = null;

		if (!wantRemote) {
			const allIPs = detectAllIPs();
			for (let j = 0; j < allIPs.length; j++) {
				const ip = allIPs[j];
				if (ip !== undefined && !ip.startsWith("100.")) {
					lanIP = ip;
					break;
				}
			}
		}

		const setupIP = wantRemote ? tsIP || "localhost" : lanIP || "localhost";
		const setupQuery = wantRemote ? "" : "?mode=lan";

		// Always use HTTP onboarding URL for QR/setup when TLS is active
		const setupUrl = config.tls
			? `http://${setupIP}:${config.port + 1}/setup${setupQuery}`
			: `http://${setupIP}:${config.port}/setup${setupQuery}`;

		log(`${sym.pointer}  ${a.bold}Continue on your device${a.reset}`, stdout);
		log(sym.bar, stdout);

		// Display QR code if generator is available
		if (opts.generateQR) {
			const qrArt = opts.generateQR(setupUrl);
			if (qrArt && !qrArt.startsWith("[QR")) {
				for (const line of qrArt.split("\n")) {
					log(`${sym.bar}  ${line}`, stdout);
				}
				log(sym.bar, stdout);
			}
		}

		log(`${sym.bar}  ${a.dim}Or open:${a.reset}`, stdout);
		log(`${sym.bar}  ${a.bold}${setupUrl}${a.reset}`, stdout);
		log(sym.bar, stdout);

		log(`${sym.done}  ${a.dim}Setup complete.${a.reset}`, stdout);
		log(sym.end, stdout);
		log("", stdout);

		await new Promise<void>((resolve) => {
			promptSelect(
				"Back?",
				[{ label: "Back", value: "back" }],
				() => resolve(),
				selectOpts,
			);
		});
		await opts.onBack();
	}
}
