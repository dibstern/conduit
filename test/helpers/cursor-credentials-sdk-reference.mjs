// Reuse C5-A's isolated Node child and source-resolution hook. No SDK patching.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { join } from "node:path";

const [row, output] = process.argv.slice(2);
const requests = [];
const server = createServer((request, response) => {
	requests.push({
		path: request.url,
		authorization: request.headers.authorization,
	});
	if (request.url === "/auth/exchange_user_api_key") {
		response.writeHead(401, { "Content-Type": "application/json" });
		response.end(
			JSON.stringify({ error: { message: "Offline privacy lookup" } }),
		);
		return;
	}
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ items: [] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const backendUrl = `http://127.0.0.1:${server.address().port}`;
process.env.CURSOR_BACKEND_URL = backendUrl;
delete process.env.CURSOR_API_KEY;
const now = Date.now();
// Freeze both clocks so the exact expiry boundary is repeatable.
Date.now = () => now;
const stored = {
	version: 1,
	backendUrl: row === "other-backend" ? "https://other.invalid" : backendUrl,
	apiKey: "c5-b-stored-login",
	createdAtMs: now - 1000,
	...(row === "future" ? { apiKeyExpiresAtMs: now + 60_000 } : {}),
	...(row === "expired" ? { apiKeyExpiresAtMs: now - 1 } : {}),
	...(row === "expires-now" ? { apiKeyExpiresAtMs: now } : {}),
};
const authDirectory = join(process.env.HOME, ".cursor", "sdk");
mkdirSync(authDirectory, { recursive: true });
writeFileSync(join(authDirectory, "auth.json"), JSON.stringify(stored));
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = new URL(typeof input === "string" ? input : (input.url ?? input));
	if (url.origin !== backendUrl)
		throw new Error(`Non-loopback SDK request: ${url.origin}`);
	return fetch(input, init);
};
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (
				error.code !== "ERR_MODULE_NOT_FOUND" ||
				!specifier.startsWith(".") ||
				!specifier.endsWith(".js") ||
				!context.parentURL?.includes("/src/")
			)
				throw error;
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
	},
});
try {
	const { Cursor } = await import("@cursor/sdk");
	let sdkError;
	try {
		// No competing keys: this pins stored-login usability, not precedence.
		await Cursor.models.list(row === "empty-key" ? { apiKey: "" } : undefined);
	} catch (error) {
		sdkError = { name: error.name, message: error.message };
	}
	const sdkRequests = requests.splice(0);
	const { cursorBackendUrl, resolveCursorCredential } = await import(
		"../../src/lib/provider/cursor/cursor-credential.ts"
	);
	const { createRealCursorSdkPort } = await import(
		"../../src/lib/provider/cursor/sdk-real.ts"
	);
	const port = createRealCursorSdkPort();
	const lookup = resolveCursorCredential(
		row === "empty-key" ? "" : undefined,
		await port.storedCredential(),
		cursorBackendUrl(backendUrl),
		now,
	);
	if (lookup._tag === "Ready") await port.modelsList(lookup.credential);
	writeFileSync(
		output,
		JSON.stringify(
			{
				row,
				lookup: lookup._tag,
				sdkError,
				sdkRequests,
				conduitRequests: requests,
			},
			null,
			2,
		),
	);
} finally {
	hooks.deregister();
	server.closeAllConnections();
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}
