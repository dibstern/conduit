import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CursorSdkFailure } from "./sdk-error.js";
import type { CursorSdkPort } from "./sdk-port.js";

export function createRealCursorSdkPort(): CursorSdkPort {
	let sdk: Promise<typeof import("@cursor/sdk")> | undefined;
	const load = () => (sdk ??= import("@cursor/sdk"));
	return {
		async probeRuntime() {
			const [major = 0, minor = 0] = process.versions.node
				.split(".")
				.map(Number);
			if (major < 22 || (major === 22 && minor < 13)) {
				return {
					available: false,
					reason: "Cursor requires Node.js 22.13 or newer",
				};
			}
			try {
				await import("node:sqlite");
			} catch {
				return { available: false, reason: "Cursor requires node:sqlite" };
			}
			try {
				await load();
			} catch {
				return { available: false, reason: "Cursor SDK could not load" };
			}
			const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
			const extension = process.platform === "win32" ? ".exe" : "";
			for (const helper of ["cursorsandbox", "rg"]) {
				const relative = join(platformPackage, "bin", `${helper}${extension}`);
				let found = false;
				// Match the SDK's lookup roots, rather than its import location.
				for (const entry of [process.argv[1], process.execPath]) {
					if (!entry) continue;
					let directory = dirname(resolve(entry));
					while (true) {
						try {
							await access(
								join(directory, "node_modules", relative),
								constants.X_OK,
							);
							found = true;
							break;
						} catch {
							const parent = dirname(directory);
							if (parent === directory) break;
							directory = parent;
						}
					}
					if (found) break;
				}
				if (!found) {
					return {
						available: false,
						reason: `Cursor platform helper is missing: ${relative}`,
					};
				}
			}
			return { available: true };
		},
		async authStatus() {
			try {
				return await (await load()).Cursor.auth.status();
			} catch {
				throw new CursorSdkFailure({
					operation: "auth.status",
					reason: "Cursor auth status failed",
				});
			}
		},
		async storedCredential() {
			try {
				const { FileCredentialStore } = await load();
				return await new FileCredentialStore().load();
			} catch {
				throw new CursorSdkFailure({
					operation: "credential.store",
					reason: "Cursor credential store could not be read",
				});
			}
		},
		async modelsList(credential) {
			try {
				return await (await load()).Cursor.models.list({
					apiKey: credential.apiKey,
				});
			} catch {
				throw new CursorSdkFailure({
					operation: "models.list",
					reason: "Cursor model list failed",
				});
			}
		},
	};
}
