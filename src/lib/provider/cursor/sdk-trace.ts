import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CursorSdkFailure } from "./sdk-error.js";
import type { CursorSdkPort } from "./sdk-port.js";

const SECRET_FIELD =
	/^(?:api[_-]?key|authorization|(?:access|refresh|session)[_-]?token|token|password|secret|(?:blob)?encryption[_-]?key|email)$/i;
const PRIVATE_HOME = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/g;

// This writer also accepts delta, stream, wait.result and create/resume/send.options
// rows. Turn operations will use it when they are added to the SDK port.
export function createCursorSdkTrace(path: string | undefined) {
	const secrets = new Set<string>();
	const collectSecrets = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (SECRET_FIELD.test(key) && typeof child === "string" && child) {
				secrets.add(child);
			}
			collectSecrets(child);
		}
	};
	const redact = (value: unknown): unknown => {
		if (typeof value === "string") {
			let text = value.replace(PRIVATE_HOME, "/home/test");
			for (const secret of secrets)
				text = text.split(secret).join("[REDACTED]");
			return text;
		}
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					SECRET_FIELD.test(key) ? "[REDACTED]" : redact(child),
				]),
			);
		}
		return value;
	};
	return {
		protect(secret: string) {
			if (secret) secrets.add(secret);
		},
		record(kind: string, data: unknown) {
			if (!path || path === "0") return;
			try {
				collectSecrets(data);
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				let empty = false;
				try {
					empty = statSync(path).size === 0;
				} catch {
					empty = true;
				}
				const header = empty
					? `${JSON.stringify({ scenario: "cursor-sdk-port", model: "discovery", sdkVersion: "1.0.37", recordedAt: new Date().toISOString() })}\n`
					: "";
				appendFileSync(
					path,
					`${header}${JSON.stringify({ kind, at: new Date().toISOString(), data: redact(data) })}\n`,
					{ mode: 0o600 },
				);
			} catch {
				// Capturing diagnostics must not change SDK behavior.
			}
		},
	};
}

export function teeCursorSdkPort(
	port: CursorSdkPort,
	path: string | undefined,
): CursorSdkPort {
	const trace = createCursorSdkTrace(path);
	if (!port.replay) {
		const apiKey = process.env["CURSOR_API_KEY"]?.trim();
		if (apiKey) trace.protect(apiKey);
	}
	const call = async <A>(
		kind: string,
		options: unknown,
		operation: () => Promise<A>,
	): Promise<A> => {
		trace.record(`${kind}.call`, options);
		try {
			const result = await operation();
			if (
				result &&
				typeof result === "object" &&
				"apiKey" in result &&
				typeof result.apiKey === "string"
			) {
				trace.protect(result.apiKey);
			}
			trace.record(kind, result ?? null);
			return result;
		} catch {
			// SDK errors may echo credentials. Keep both trace and caller safe.
			const message = `Cursor ${kind} failed`;
			trace.record(`${kind}.error`, { message });
			throw new CursorSdkFailure({ operation: kind, reason: message });
		}
	};
	return {
		...(port.replay ? { replay: true } : {}),
		probeRuntime: () => call("runtime.probe", {}, () => port.probeRuntime()),
		authStatus: () => call("auth.status", {}, () => port.authStatus()),
		storedCredential: () =>
			call("credential.store", {}, () => port.storedCredential()),
		modelsList: (credential) => {
			trace.protect(credential.apiKey);
			return call("models.list", { credential }, () =>
				port.modelsList(credential),
			);
		},
	};
}
