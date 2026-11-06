// Two projects registered on one folder each list only their own hosted terminals (82tn.82), on
// the tab that opened them, on a reconnect and after a daemon restart. A terminal the host holds
// with no project recorded (made by an older daemon) lists in both. Artifact:
// test-results/shared-folder-terminal-lists/result.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Written whether the test passes or not, so a failure shows the last step reached.
const evidence: Record<string, unknown> = {};
afterEach(async () => {
	mkdirSync("test-results/shared-folder-terminal-lists", { recursive: true });
	writeFileSync(
		"test-results/shared-folder-terminal-lists/result.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	host?.disconnect();
	host = undefined;
	await harness?.dispose();
	harness = undefined;
});

it("each of two projects on a shared folder lists only its own terminals", async () => {
	harness = await ProcessHarness.start({ dist: DIST });
	await harness.kill();
	// Adding a project on a folder another project holds is refused, so the shared folder comes
	// from the config file, as an older daemon could have written it.
	const configPath = join(harness.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		projects: { slug: string; title?: string }[];
	};
	const first = config.projects.find(({ slug }) => slug === "process-test");
	config.projects.push({ ...first, slug: "process-test-b", title: "b" });
	writeFileSync(configPath, JSON.stringify(config));
	await harness.restart();

	const slugs = ["process-test", "process-test-b"] as const;
	const tabs = async () =>
		Promise.all(
			slugs.map((slug) => harness?.connect(undefined, undefined, slug)),
		);
	const opened = await tabs();
	const [aPty, bPty] = await Promise.all(opened.map((tab) => tab?.createPty()));
	// Made with no project recorded, as by an older daemon.
	host = await PtyHostClient.connect({ configDir: harness.configDir });
	const unowned = await host.create({ cwd: harness.projectDir });
	const lists = async (open: Awaited<ReturnType<typeof tabs>>) =>
		Object.fromEntries(
			await Promise.all(
				open.map(async (tab, index) => [
					slugs[index],
					((await tab?.listPtys()) ?? [])
						.filter(({ status }) => status !== "exited")
						.map(({ id }) => id)
						.sort(),
				]),
			),
		);
	evidence["opened"] = await lists(opened);
	evidence["reconnected"] = await lists(await tabs());
	await harness.kill();
	await harness.restart({ skipBrowserProbe: true });
	evidence["restarted"] = await lists(await tabs());

	const expected = {
		"process-test": [aPty?.id, unowned.pty.id].sort(),
		"process-test-b": [bPty?.id, unowned.pty.id].sort(),
	};
	expect(evidence).toEqual({
		opened: expected,
		reconnected: expected,
		restarted: expected,
	});
});
