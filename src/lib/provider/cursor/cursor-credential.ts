import { createHash } from "node:crypto";
import type { CursorCredential, CursorSdkPort } from "./sdk-port.js";

export function cursorEnvironmentKey(
	port: CursorSdkPort,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	// Replay never consumes a developer's real credential.
	return !port.replay ||
		(env["NODE_ENV"] === "test" &&
			env["CURSOR_API_KEY"] === "[REDACTED:environment]")
		? env["CURSOR_API_KEY"]?.trim()
		: undefined;
}

export async function resolveCursorCredential(
	port: CursorSdkPort,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CursorCredential | undefined> {
	const environmentKey = cursorEnvironmentKey(port, env);
	const stored = environmentKey ? undefined : await port.storedCredential();
	if (
		!environmentKey &&
		(!stored ||
			(stored.apiKeyExpiresAtMs !== undefined &&
				stored.apiKeyExpiresAtMs <= Date.now()))
	) {
		return undefined;
	}
	const apiKey = environmentKey || stored?.apiKey;
	if (!apiKey) return undefined;
	const credential = {
		source: environmentKey ? "environment" : "sdk-login",
		fingerprint: createHash("sha256")
			.update(
				JSON.stringify([
					environmentKey ? "environment" : "sdk-login",
					stored?.backendUrl ?? "",
					apiKey,
				]),
			)
			.digest("hex"),
		...(!environmentKey && stored ? { backendUrl: stored.backendUrl } : {}),
	} as CursorCredential;
	// Accidental JSON/log serialization must not expose the credential.
	Object.defineProperty(credential, "apiKey", {
		value: apiKey,
		enumerable: false,
	});
	return Object.freeze(credential);
}
