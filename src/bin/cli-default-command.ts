import { resolve } from "node:path";
import type { Request } from "effect/Request";
import {
	GetProjects,
	GetStatus,
	SaveProject,
} from "../lib/contracts/ws-rpc.js";
import type { CommandContext } from "./cli-command-handlers.js";

export async function handleDefault(ctx: CommandContext): Promise<void> {
	const {
		args,
		cwd,
		stdout,
		stderr,
		exit,
		rpcSend,
		checkDaemon,
		getAddr,
		getTsIP,
		qr,
	} = ctx;

	if (args.skipPerms && !args.pin) {
		stderr.write("--dangerously-skip-permissions requires --pin\n");
		exit(1);
		return;
	}

	const unavailable =
		"Server is not running. Run conduit serve or conduit service install.\n";
	if (!(await checkDaemon().catch(() => false))) {
		stderr.write(unavailable);
		exit(1);
		return;
	}

	let slug: string | undefined;
	try {
		const directory = resolve(cwd);
		const { projects } = await rpcSend(new GetProjects({}));
		const existing = projects.find(
			(project) => (project.folders?.[0] ?? project.directory) === directory,
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
	const url = `${scheme}://${primaryIP}:${port}`;
	const tlsActive = statusResponse["tlsEnabled"] === true;

	if (primaryIP !== "localhost") {
		const qrUrl = tlsActive ? `http://${primaryIP}:${port + 1}/setup` : url;
		const qrCode = qr(qrUrl);
		if (qrCode) {
			stdout.write("\n");
			stdout.write(qrCode);
			if (tlsActive) {
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
	if (tsIP && lanIP && tsIP !== lanIP) {
		stdout.write(`  Local: ${scheme}://${lanIP}:${port}\n`);
	}

	if (slug) {
		stdout.write(`  Project: ${slug} (${cwd})\n`);
	}

	stdout.write("Tip: Set a PIN for security: conduit --pin <4-8 digits>\n");
	stdout.write("\n");
}
