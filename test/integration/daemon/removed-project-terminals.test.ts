// A project's hosted terminals close when it is removed, though no tab opened it since the
// daemon restarted (82tn.16): the daemon, not a project relay, owns the hosted terminals.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const { PtyHostClient } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-client.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-client.js");

let harness: ProcessHarness | undefined;
let host: Awaited<ReturnType<typeof PtyHostClient.connect>> | undefined;
// Written whether the test passes or not, so a hang shows the last step reached.
const evidence: Record<string, unknown> = {};
afterEach(async () => {
	mkdirSync("test-results/removed-project-terminals", { recursive: true });
	writeFileSync(
		"test-results/removed-project-terminals/result.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	host?.disconnect();
	host = undefined;
	await harness?.dispose();
	harness = undefined;
});

it("closes a removed project's hosted terminal that no tab reopened after a restart", async () => {
	harness = await ProcessHarness.start({ dist: DIST });
	const pty = await (await harness.connect()).createPty();
	await harness.kill();
	// No tab opens the project: nothing serves it after this start.
	await harness.restart({ skipBrowserProbe: true });
	host = await PtyHostClient.connect({ configDir: harness.configDir });
	evidence["ptyId"] = pty.id;
	evidence["hostedBefore"] = (await host.list(harness.projectDir)).map(
		({ pty }) => pty.id,
	);
	const session = await host.attach(pty.id, harness.projectDir);
	const exited = new Promise<number>((resolve) => session.onExit(resolve));
	await harness.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
	evidence["removed"] = true;
	evidence["exitCode"] = await exited;
	evidence["hostedAfter"] = (await host.list(harness.projectDir)).map(
		({ pty }) => pty.id,
	);
	expect(evidence).toMatchObject({
		hostedBefore: [pty.id],
		removed: true,
		hostedAfter: [],
	});
});
