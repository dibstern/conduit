import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { SaveProject } from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

/** The real binary from CONDUIT_TEST_REAL_OPENCODE or PATH, if it matches the pinned SDK. */
function realOpenCode(): { path: string; version: string } | { skip: string } {
	const pinned = (
		JSON.parse(readFileSync("package.json", "utf8")) as {
			dependencies: Record<string, string>;
		}
	).dependencies["@opencode-ai/sdk"];
	const path = [
		process.env["CONDUIT_TEST_REAL_OPENCODE"],
		...(process.env["PATH"] ?? "")
			.split(delimiter)
			.map((directory) => join(directory, "opencode")),
	].find((candidate) => {
		if (!candidate) return false;
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	if (!path) return { skip: "no opencode binary on PATH" };
	// Even --version may initialise OpenCode's dirs, so point them at a temp root.
	const scratch = mkdtempSync(join(tmpdir(), "conduit-opencode-version-"));
	try {
		const version = execFileSync(path, ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: scratch,
				XDG_CONFIG_HOME: join(scratch, "config"),
				XDG_DATA_HOME: join(scratch, "data"),
				XDG_STATE_HOME: join(scratch, "state"),
				XDG_CACHE_HOME: join(scratch, "cache"),
			},
		}).trim();
		return version === pinned
			? { path: realpathSync(path), version }
			: {
					skip: `${path} is OpenCode ${version}, but @opencode-ai/sdk is pinned to ${pinned}`,
				};
	} catch (cause) {
		return { skip: `${path} --version failed: ${String(cause)}` };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const binary = realOpenCode();

// Failure cases against the real binary: starting before any user action, one
// process or stream per project, an event for one project's directory reaching
// the other, and an idle stop leaving the binary, its proxy, the supervisor or
// any descendant behind, or the stream open. No prompt is ever sent.
describe("Managed real OpenCode lifecycle", () => {
	const instanceId = defaultInstanceIdForDriver("opencode");
	// Long enough for steps 1-3 to finish under load before the idle stop.
	const graceMs = 12_000;
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {
		ticket: "conduit-test-pa3r.10",
		at: new Date().toISOString(),
		binary,
	};
	const snapshots: Array<
		{ step: string; at: number } & ReturnType<typeof tree>
	> = [];

	/**
	 * Every process of the OpenCode launched under the harness root: the
	 * supervisor's group around `<root>/bin/opencode*`, plus any descendant
	 * that left the group.
	 */
	function tree(fixture: ProcessHarness) {
		const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
			encoding: "utf8",
		})
			.split("\n")
			.flatMap((line) => {
				const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
				return match
					? [
							{
								pid: Number(match[1]),
								ppid: Number(match[2]),
								pgid: Number(match[3]),
								command: match[4] ?? "",
							},
						]
					: [];
			});
		const launcher = join(fixture.root, "bin", "opencode");
		const groups = new Set(
			rows
				.filter(({ command }) => command.includes(launcher))
				.map(({ pgid }) => pgid),
		);
		const members = new Set(
			rows.filter(({ pgid }) => groups.has(pgid)).map(({ pid }) => pid),
		);
		for (let grown = true; grown; ) {
			grown = false;
			for (const { pid, ppid } of rows)
				if (members.has(ppid) && !members.has(pid)) {
					members.add(pid);
					grown = true;
				}
		}
		const processes = rows.filter(({ pid }) => members.has(pid));
		return {
			processes,
			binaries: processes
				.filter(({ command }) => command.includes(`${launcher}-real `))
				.map(({ pid }) => pid),
		};
	}

	function snapshot(fixture: ProcessHarness, step: string) {
		const taken = { step, at: Date.now(), ...tree(fixture) };
		snapshots.push(taken);
		return taken;
	}

	const sleep = (ms: number) =>
		new Promise<void>((done) => setTimeout(done, ms));

	const streamOpens = (fixture: ProcessHarness) =>
		fixture
			.opencodeStreamConnections()
			.filter(({ action }) => action === "open");

	/** Calls the real OpenCode directly, as another client such as its TUI would. */
	async function opencode(
		fixture: ProcessHarness,
		method: string,
		path: string,
		directory: string,
		body?: unknown,
	) {
		const instance = loadDaemonConfig(fixture.configDir)?.instances?.find(
			({ id }) => id === instanceId,
		);
		if (!instance?.port) throw new Error("Managed OpenCode has no port");
		const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
			method,
			headers: {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
				"Content-Type": "application/json",
				"x-opencode-directory": directory,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new Error(`OpenCode ${method} ${path}: ${response.status}`);
		return (await response.json()) as unknown;
	}

	const mentions = (browser: ProcessBrowser, id: string) =>
		browser.frames.filter(({ message }) => JSON.stringify(message).includes(id))
			.length;
	const rows = (browser: ProcessBrowser, id: string) =>
		browser.frames.filter(
			({ message }) =>
				message["type"] === "session_row" && message["id"] === id,
		).length;

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["snapshots"] = snapshots;
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["requests"] = fixture.opencodeRequests();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				evidence["afterDispose"] = tree(fixture);
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/pa3r-10-real-lifecycle.json",
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("starts on the first session, shares one process and stream across projects, routes by directory, and stops when idle", async ({
		skip,
	}) => {
		if ("skip" in binary) return skip(binary.skip);
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			realOpenCode: binary.path,
			rootPrefix: "/tmp/conduit-real-opencode-",
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: graceMs });
		const directoryB = join(fixture.root, "project-b");
		mkdirSync(directoryB);
		const { savedSlug: slugB } = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new SaveProject({ folders: [directoryB] }),
		);
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, slugB);
		await a.followSessions();
		await b.followSessions();
		// Background paths (pollers, status, attach) get time to (wrongly)
		// start it.
		await sleep(3_000);
		const attached = snapshot(fixture, "attached");
		expect(attached.processes).toEqual([]);
		expect(fixture.opencodeRequests()).toEqual([]);

		// 1. Lazy spawn: the first OpenCode session starts exactly one.
		const sessionA = await a.createSession("Real A", instanceId, "opencode");
		const first = snapshot(fixture, "first-session");
		expect(first.binaries).toHaveLength(1);
		const port = loadDaemonConfig(fixture.configDir)?.instances?.find(
			({ id }) => id === instanceId,
		)?.port;
		evidence["port"] = port;
		expect([4096, 2633]).not.toContain(port);

		// 2. A session in the second project reuses the process and stream.
		const sessionB = await b.createSession("Real B", instanceId, "opencode");
		const second = snapshot(fixture, "second-session");
		expect(second.binaries).toEqual(first.binaries);
		await vi.waitFor(() =>
			expect(streamOpens(fixture)).toEqual([
				expect.objectContaining({ path: "/global/event" }),
			]),
		);

		// 3. Sessions another OpenCode client creates arrive on the shared
		// stream and reach only the project that owns their directory.
		const external = async (directory: string) =>
			(
				(await opencode(fixture, "POST", "/session", directory, {})) as {
					id: string;
				}
			).id;
		const externalA = await external(fixture.projectDir);
		const externalB = await external(directoryB);
		const isRow = (id: string) => (message: Record<string, unknown>) =>
			message["type"] === "session_row" && message["id"] === id;
		await a.waitFor(isRow(externalA));
		await b.waitFor(isRow(externalB));
		const routed = (browser: ProcessBrowser, ids: string[]) =>
			Object.fromEntries(
				ids.map((id) => [
					id,
					{ rows: rows(browser, id), frames: mentions(browser, id) },
				]),
			);
		const ids = [sessionA, externalA, sessionB, externalB];
		const counts = { a: routed(a, ids), b: routed(b, ids) };
		evidence["routedEventCounts"] = counts;
		for (const [browser, own, other] of [
			[counts.a, [sessionA, externalA], [sessionB, externalB]],
			[counts.b, [sessionB, externalB], [sessionA, externalA]],
		] as const) {
			for (const id of own) expect(browser[id]?.rows).toBeGreaterThan(0);
			for (const id of other)
				expect(browser[id]).toEqual({ rows: 0, frames: 0 });
		}

		// 4. Idle stop: no use is open and nothing is busy, so after the
		// grace period the whole process tree goes and the stream closes.
		const idleFrom = Date.now();
		await vi.waitFor(() => expect(tree(fixture).processes).toEqual([]), {
			timeout: 30_000,
			interval: 250,
		});
		const stopped = snapshot(fixture, "idle-stopped");
		evidence["stopAfterMs"] = stopped.at - idleFrom;
		const connections = fixture.opencodeStreamConnections();
		expect(connections).toEqual([
			expect.objectContaining({ action: "open", path: "/global/event" }),
			expect.objectContaining({ action: "close", path: "/global/event" }),
		]);
		// The status flips once the stop has confirmed the group is gone.
		await vi.waitFor(
			async () =>
				expect((await a.instanceStatus(instanceId)).instance?.status).toBe(
					"stopped",
				),
			{ timeout: 10_000, interval: 250 },
		);
		// No model call: nothing ever asked OpenCode to run a turn.
		expect(
			fixture
				.opencodeRequests()
				.filter(({ url }) =>
					/\/session\/[^/]+\/(message|prompt_async|command|shell)/.test(url),
				)
				.filter(({ method }) => method === "POST"),
		).toEqual([]);
	}, 180_000);
});
