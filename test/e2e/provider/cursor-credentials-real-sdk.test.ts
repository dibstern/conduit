// Failure modes: a foreign or expired login reaches the wire, the exact expiry
// boundary drifts, or an empty account key stops falling through to the login.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Cursor stored-login usability against the installed SDK offline", () => {
	it.each([
		["no-expiry", "Ready", true],
		["future", "Ready", true],
		["expired", "Expired", false],
		["expires-now", "Expired", false],
		["other-backend", "OtherBackend", false],
		["empty-key", "Ready", true],
	] as const)("%s", (row, lookup, usable) => {
		mkdirSync("test-results", { recursive: true });
		const home = mkdtempSync(resolve(`test-results/c5-b-credential-${row}-`));
		// Unique per run, so overlapping runs never read each other's evidence.
		const output = `${home}.json`;
		try {
			execFileSync(
				process.execPath,
				[
					resolve("test/helpers/cursor-credentials-sdk-reference.mjs"),
					row,
					output,
				],
				{
					env: {
						...process.env,
						HOME: home,
						USERPROFILE: home,
						XDG_CONFIG_HOME: join(home, ".config"),
					},
					stdio: "pipe",
					timeout: 30_000,
				},
			);
			const evidence = JSON.parse(readFileSync(output, "utf8")) as {
				lookup: string;
				sdkError?: { name: string };
				sdkRequests: { path: string; authorization: string }[];
				conduitRequests: { path: string; authorization: string }[];
			};
			const request = {
				path: "/v1/models",
				authorization: "Bearer c5-b-stored-login",
			};
			expect(evidence.lookup).toBe(lookup);
			for (const requests of [evidence.conduitRequests, evidence.sdkRequests]) {
				for (const observed of requests)
					expect(observed.authorization).toBe(request.authorization);
			}
			expect(
				evidence.conduitRequests.filter(({ path }) => path === "/v1/models"),
			).toEqual(usable ? [request] : []);
			expect(
				evidence.sdkRequests.filter(({ path }) => path === "/v1/models"),
			).toEqual(usable && row !== "empty-key" ? [request] : []);
			if (!usable) expect(evidence.conduitRequests).toEqual([]);
			if (!usable || row === "empty-key")
				expect(evidence.sdkRequests).toEqual([]);
			if (!usable || row === "empty-key") {
				expect(evidence.sdkError?.name).toBe("ConfigurationError");
			} else {
				expect(evidence.sdkError).toBeUndefined();
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
