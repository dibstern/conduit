// Pure helper functions used by both RelayServer (server.ts) and Daemon (daemon.ts).

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** Read the full body of an incoming HTTP request as a UTF-8 string. */
export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

export function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
	return address === "::1" || (isIP(ipv4) === 4 && ipv4.startsWith("127."));
}

/** Only trust a loopback proxy's last non-empty XFF entry. */
export function getClientIp(
	peer: string | undefined,
	forwarded: string | readonly string[] | undefined,
): string {
	const address = peer ?? "unknown";
	if (isLoopbackAddress(peer) && typeof forwarded === "string") {
		const entries = forwarded.split(",");
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]?.trim();
			if (entry) return entry;
		}
	}
	return address;
}

/** Parse a Cookie header string into key-value pairs. */
export function parseCookies(header: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const [key, ...rest] = pair.split("=");
		if (key) {
			result[key.trim()] = rest.join("=").trim();
		}
	}
	return result;
}
