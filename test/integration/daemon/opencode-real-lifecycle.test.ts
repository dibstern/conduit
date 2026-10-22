import { execFileSync, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";

import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

/** The pinned executable (or explicit override), if it matches the pinned SDK. */
function realOpenCode(): { path: string; version: string } | { skip: string } {
	const pinned = (
		JSON.parse(readFileSync("package.json", "utf8")) as {
			dependencies: Record<string, string>;
		}
	).dependencies["@opencode-ai/sdk"];
	const path = resolveRealOpenCode();
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
			? { path, version }
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
	const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
	// Long enough for steps 1-3 to finish under load before the idle stop.
	const graceMs = 12_000;
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {
		ticket: "conduit-test-pa3r.10",
		at: new Date().toISOString(),
		binary,
	};
	const snapshots: Array<
		{ step: string; at: number } & Awaited<ReturnType<typeof tree>>
	> = [];

	/**
	 * Every process of the OpenCode launched under the harness root: the
	 * supervisor's group around `<root>/bin/opencode*`, plus any descendant
	 * that left the group.
	 */
	async function tree(fixture: ProcessHarness) {
		// A shared host's command listing can exceed execFileSync's stdout buffer.
		const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stderr: Buffer[] = [];
		let stderrBytes = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			const kept = chunk.subarray(0, Math.max(0, 4096 - stderrBytes));
			if (kept.length) stderr.push(kept);
			stderrBytes += kept.length;
		});
		const closed = new Promise<void>((done, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) done();
				else
					reject(
						new Error(
							`ps exited ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8")}`,
						),
					);
			});
		});
		const rows: Array<{
			pid: number;
			ppid: number;
			pgid: number;
			command: string;
		}> = [];
		const lines = createInterface({ input: child.stdout });
		try {
			await Promise.all([
				(async () => {
					for await (const line of lines) {
						const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
						if (match)
							rows.push({
								pid: Number(match[1]),
								ppid: Number(match[2]),
								pgid: Number(match[3]),
								command: match[4] ?? "",
							});
					}
				})(),
				closed,
			]);
		} finally {
			lines.close();
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGTERM");
			await closed.catch(() => {});
		}
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

	async function snapshot(fixture: ProcessHarness, step: string) {
		const taken = { step, at: Date.now(), ...(await tree(fixture)) };
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
		const instance = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === instanceId);
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

	const details = (browser: ProcessBrowser, id: string) =>
		browser.frames.filter(
			({ message }) =>
				(message["type"] === "session_detail" ||
					message["type"] === "transcript_message") &&
				JSON.stringify(message).includes(id),
		).length;
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
				evidence["afterDispose"] = await tree(fixture);
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
			{ _tag: "SaveProject", folders: [directoryB] },
		);
		const slugA = "process-test";
		const a = await fixture.connect(undefined, undefined, slugA);
		const b = await fixture.connect(undefined, undefined, slugB);
		await a.followSessions();
		await b.followSessions();
		// Background paths (pollers, status, attach) get time to (wrongly)
		// start it.
		await sleep(3_000);
		const attached = await snapshot(fixture, "attached");
		expect(attached.processes).toEqual([]);
		expect(fixture.opencodeRequests()).toEqual([]);

		// 1. Lazy spawn: the first OpenCode session starts exactly one.
		const sessionA = await a.createSession("Real A", instanceId, "opencode");
		const first = await snapshot(fixture, "first-session");
		expect(first.binaries).toHaveLength(1);
		const port = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === instanceId)?.port;
		evidence["port"] = port;
		expect([4096, 2633]).not.toContain(port);

		// 2. A session in the second project reuses the process and stream.
		const sessionB = await b.createSession("Real B", instanceId, "opencode");
		const second = await snapshot(fixture, "second-session");
		expect(second.binaries).toEqual(first.binaries);
		await vi.waitFor(() =>
			expect(streamOpens(fixture)).toEqual([
				expect.objectContaining({ path: "/global/event" }),
			]),
		);

		// 3. Sessions another OpenCode client creates arrive on the shared
		// stream with the correct project ownership. Shell rows are daemon-wide;
		// each browser follows details only for its own project's sessions.
		const external = async (directory: string) =>
			(
				(await opencode(fixture, "POST", "/session", directory, {})) as {
					id: string;
				}
			).id;
		const externalA = await external(fixture.projectDir);
		const externalB = await external(directoryB);
		for (const [browser, browserSlug] of [
			[a, slugA],
			[b, slugB],
		] as const) {
			for (const [id, projectSlug] of [
				[sessionA, slugA],
				[externalA, slugA],
				[sessionB, slugB],
				[externalB, slugB],
			] as const) {
				await browser.waitFor(
					(message) =>
						message["type"] === "session_row" && message["id"] === id,
				);
				expect(
					new Set(
						browser.frames
							.filter(
								({ message }) =>
									message["type"] === "session_row" && message["id"] === id,
							)
							.map(({ message }) => message["projectSlug"]),
					),
				).toEqual(new Set([projectSlug]));
				if (projectSlug === browserSlug)
					await browser.waitFor(
						(message) =>
							message["type"] === "session_detail" &&
							message["sessionId"] === id &&
							message["_tag"] === "synchronized",
					);
			}
		}
		const routed = (browser: ProcessBrowser, ids: string[]) =>
			Object.fromEntries(
				ids.map((id) => [
					id,
					{ rows: rows(browser, id), details: details(browser, id) },
				]),
			);
		const ids = [sessionA, externalA, sessionB, externalB];
		const counts = { a: routed(a, ids), b: routed(b, ids) };
		evidence["routedEventCounts"] = counts;
		for (const [browser, own, other] of [
			[counts.a, [sessionA, externalA], [sessionB, externalB]],
			[counts.b, [sessionB, externalB], [sessionA, externalA]],
		] as const) {
			for (const id of [...own, ...other])
				expect(browser[id]?.rows).toBeGreaterThan(0);
			for (const id of own) expect(browser[id]?.details).toBeGreaterThan(0);
			for (const id of other) expect(browser[id]?.details).toBe(0);
		}

		// 4. Idle stop: no use is open and nothing is busy, so after the
		// grace period the whole process tree goes and the stream closes.
		const idleFrom = Date.now();
		await vi.waitFor(
			async () => expect((await tree(fixture)).processes).toEqual([]),
			{
				timeout: 30_000,
				interval: 250,
			},
		);
		const stopped = await snapshot(fixture, "idle-stopped");
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
