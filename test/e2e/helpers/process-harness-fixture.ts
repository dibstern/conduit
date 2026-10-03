import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "@playwright/test";
import { isProcessAlive } from "../../../src/lib/instance/managed-opencode-process.js";
import { PtyHostClient } from "../../../src/lib/terminal/pty-host-client.js";
import { ptyHostSocketPath } from "../../../src/lib/terminal/pty-host-protocol.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

export { expect } from "@playwright/test";

export const test = base.extend<{
	harnessOptions: NonNullable<Parameters<typeof ProcessHarness.create>[0]>;
	harness: ProcessHarness;
}>({
	harnessOptions: [{}, { option: true }],
	harness: [
		async ({ harnessOptions }, use) => {
			const dist =
				harnessOptions.dist ?? process.env["CONDUIT_TEST_DIST"] ?? "dist";
			const harness = await ProcessHarness.start({
				...harnessOptions,
				dist,
			});
			try {
				await use(harness);
			} finally {
				let hostPid: number | undefined;
				try {
					if (existsSync(ptyHostSocketPath(harness.configDir))) {
						const { BUILD_ID } = (await import(
							pathToFileURL(resolve(dist, "src/lib/build-id.js")).href
						)) as { BUILD_ID: string };
						const host = await PtyHostClient.connect({
							configDir: harness.configDir,
							buildId: BUILD_ID,
							start: false,
						});
						hostPid = host.hello.pid;
						host.disconnect();
					}
				} finally {
					await harness.dispose();
					harness.assertNoRunners();
					await expect
						.poll(() => hostPid !== undefined && isProcessAlive(hostPid))
						.toBe(false);
					expect(harness.ownedOpenCodePids().filter(isProcessAlive)).toEqual(
						[],
					);
					expect(harness.proof()).toMatchObject({
						remainingObservedOpenCodePids: [],
					});
				}
			}
		},
		{ timeout: 60_000 },
	],
});
