// ─── Shared HTTP Utilities ───────────────────────────────────────────────────
// Pure helper functions used by both RelayServer (server.ts) and Daemon (daemon.ts).

import type { IncomingMessage } from "node:http";

/** Read the full body of an incoming HTTP request as a UTF-8 string. */
export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

/** Extract client IP from X-Forwarded-For header or socket address. */
export function getClientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string")
		return (forwarded.split(",")[0] ?? "").trim();
	return req.socket.remoteAddress ?? "unknown";
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
