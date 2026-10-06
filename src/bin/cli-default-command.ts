import { resolve } from "node:path";
import type { Request } from "effect/Request";
import {
	GetProjects,
	GetStatus,
	SaveProject,
} from "../lib/contracts/ws-rpc.js";
import { type CommandContext, handleServe } from "./cli-command-handlers.js";

export async function handleDefault(ctx: CommandContext): Promise<void> {
	const { args, stderr, exit, checkDaemon } = ctx;

	if (args.skipPerms && !args.pin) {
		stderr.write("--dangerously-skip-permissions requires --pin\n");
		exit(1);
		return;
	}

	// No server yet: serve in the foreground with cwd registered, like `npx vite`.
	if (!(await checkDaemon().catch(() => false))) {
		return handleServe(ctx, () => showProject(ctx));
	}
	return showProject(ctx);
}

async function showProject(ctx: CommandContext): Promise<void> {
	const { args, cwd, stdout, stderr, exit, rpcSend, getAddr, getTsIP, qr } =
		ctx;
	const unavailable =
		"Server is not running. Run conduit serve or conduit service install.\n";

	let slug: string | undefined;
	try {
		const directory = resolve(cwd);
		const { projects } = await rpcSend(new GetProjects({}));
		const existing = projects.find(
			(project) => project.folders[0] === directory,
		);
		const registerResponse = await rpcSend(
			new SaveProject({
				...(existing ? { slug: existing.slug } : {}),
				folders: [directory],
			}),
		);
		slug = registerResponse.savedSlug;
	} catch {
		// The default view remains available when project registration fails.
	}

	let statusResponse: Request.Success<GetStatus>;
	try {
		statusResponse = await rpcSend(new GetStatus({}));
	} catch {
		stderr.write(unavailable);
		exit(1);
		return;
	}
	const port =
		typeof statusResponse.port === "number" ? statusResponse.port : args.port;
	const scheme = statusResponse["tlsEnabled"] === true ? "https" : "http";
	// Prefer Tailscale for share URLs, then LAN, then localhost.
	const tsIP = getTsIP();
	const lanIP = getAddr();
	const primaryIP = tsIP ?? lanIP ?? "localhost";
	const tailscale = statusResponse.tailscaleServe;
	const tailscaleUrl =
		tailscale && "url" in tailscale ? tailscale.url : undefined;
	const url =
		tailscaleUrl ??
		(tailscale
			? `http://127.0.0.1:${port}`
			: `${scheme}://${primaryIP}:${port}`);
	const tlsActive = statusResponse["tlsEnabled"] === true;

	if (tailscaleUrl || (!tailscale && primaryIP !== "localhost")) {
		const qrUrl =
			tailscaleUrl ??
			(tlsActive ? `http://${primaryIP}:${port + 1}/setup` : url);
		const qrCode = qr(qrUrl);
		if (qrCode) {
			stdout.write("\n");
			stdout.write(qrCode);
			if (tlsActive && !tailscaleUrl) {
				stdout.write(
					`  Scan or visit: http://${primaryIP}:${port + 1}/setup\n`,
				);
			}
			stdout.write("\n");
		}
	}

	stdout.write("\n");
	stdout.write("conduit\n");
	stdout.write(`  URL: ${url}\n`);
	if (tailscaleUrl) {
		stdout.write(`  Local: http://localhost:${port}\n`);
	} else if (!tailscale && tsIP && lanIP && tsIP !== lanIP) {
		stdout.write(`  Local: ${scheme}://${lanIP}:${port}\n`);
	}
	if (tailscale && "error" in tailscale) {
		stderr.write(`  Tailscale Serve: ${tailscale.error}\n`);
	} else if (!tailscale && tsIP) {
		stdout.write(
			"  Tip: Use conduit serve --tailscale-serve for trusted HTTPS on your tailnet.\n",
		);
	}

	if (slug) {
		stdout.write(`  Project: ${slug} (${cwd})\n`);
	}

	stdout.write("Tip: Set a PIN for security: conduit --pin <4-8 digits>\n");
	stdout.write("\n");
}
