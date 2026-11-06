// Two projects registered on one folder each keep their own hosted terminals (82tn.78): removing
// one closes its terminal and leaves the other's open, across a daemon restart in between. The
// PTY host outlives the daemon, so it must know which project made each terminal. Artifact:
// test-results/shared-folder-terminals/result.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
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
	mkdirSync("test-results/shared-folder-terminals", { recursive: true });
	writeFileSync(
		"test-results/shared-folder-terminals/result.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	host?.disconnect();
	host = undefined;
	await harness?.dispose();
	harness = undefined;
});

it("removing one of two projects on a shared folder closes only its own terminal", async () => {
	harness = await ProcessHarness.start({ dist: DIST });
	await harness.kill();
	// Adding a project on a folder another project holds is refused, so the shared folder comes
	// from the config file, as an older daemon could have written it.
	const configPath = join(harness.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		projects: { slug: string; title?: string }[];
	};
	const kept = config.projects.find(({ slug }) => slug === "process-test");
	config.projects.push({ ...kept, slug: "process-test-b", title: "b" });
	writeFileSync(configPath, JSON.stringify(config));
	await harness.restart();

	const keptPty = await (
		await harness.connect(undefined, undefined, "process-test")
	).createPty();
	const removedPty = await (
		await harness.connect(undefined, undefined, "process-test-b")
	).createPty();
	// The host keeps both terminals while no daemon runs.
	await harness.kill();
	await harness.restart({ skipBrowserProbe: true });

	const client = await PtyHostClient.connect({ configDir: harness.configDir });
	host = client;
	const { projectDir } = harness;
	const hosted = async () =>
		(await client.list(projectDir))
			.filter(({ exitCode }) => exitCode === null)
			.map(({ pty }) => pty.id)
			.sort();
	evidence["hostedBefore"] = await hosted();
	// Attached before the removal, so neither exit is missed.
	const [keptSession, removedSession] = await Promise.all(
		[keptPty, removedPty].map(({ id }) => client.attach(id, projectDir)),
	);
	const exitOf = (session: typeof keptSession) =>
		new Promise<number>((resolve) => session?.onExit(resolve));
	const keptExit = exitOf(keptSession);
	const removedExit = exitOf(removedSession);
	/** True when the terminal exited within the wait, false when it stayed open. */
	const closedOn = (exited: Promise<number>) =>
		Effect.runPromise(
			Effect.promise(() => exited).pipe(
				Effect.as(true),
				Effect.timeout("5 seconds"),
				Effect.catch(() => Effect.succeed(false)),
			),
		);

	await harness.requestRpc({ _tag: "RemoveProject", slug: "process-test-b" });
	evidence["removedClosed"] = await closedOn(removedExit);
	evidence["keptClosed"] = await closedOn(keptExit);
	evidence["hostedAfter"] = await hosted();
	expect(evidence).toEqual({
		hostedBefore: [keptPty.id, removedPty.id].sort(),
		removedClosed: true,
		keptClosed: false,
		hostedAfter: [keptPty.id],
	});
});
