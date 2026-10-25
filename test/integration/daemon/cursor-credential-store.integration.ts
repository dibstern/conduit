import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createRealCursorSdkPort } from "../../../src/lib/provider/cursor/sdk-real.js";

// The real SDK must read and clear only the explicitly selected file. Replay
// cannot prove this: its auth state lives in a separate test-owned JSON file.
it("uses the same explicit FileCredentialStore for status, credentials and logout", async () => {
	const root = mkdtempSync("/tmp/conduit-cursor-stores-");
	try {
		const paths = [join(root, "a", "auth.json"), join(root, "b", "auth.json")];
		const ports = paths.map(createRealCursorSdkPort);
		for (const [index, path] of paths.entries()) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				JSON.stringify({
					version: 1,
					apiKey: `[REDACTED:account-${index}]`,
					backendUrl: "https://api2.cursor.sh",
					email: `account-${index}@example.test`,
					createdAtMs: Date.now(),
				}),
				{ mode: 0o600 },
			);
			expect(await ports[index]?.authStatus()).toMatchObject({
				status: "logged-in",
				email: `account-${index}@example.test`,
			});
			expect(await ports[index]?.storedCredential()).toMatchObject({
				apiKey: `[REDACTED:account-${index}]`,
			});
		}
		await ports[0]?.authLogout();
		expect(await ports[0]?.authStatus()).toEqual({ status: "logged-out" });
		expect(await ports[0]?.storedCredential()).toBeUndefined();
		expect(await ports[1]?.authStatus()).toMatchObject({
			status: "logged-in",
			email: "account-1@example.test",
		});
		expect(await ports[1]?.storedCredential()).toMatchObject({
			apiKey: "[REDACTED:account-1]",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
