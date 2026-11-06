import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CursorAgentOptions } from "../../../../src/lib/provider/cursor/sdk-port.js";
import { createTraceCursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-trace-player.js";
import { cursorCredentialFixture } from "../../../helpers/cursor-account-resources-fixture.js";

// Failure modes 1-6 in the lane 75 audit: a new agent shares the old agent's id
// and runs, a resumed agent loses its id or runs, two captured agents replay out
// of order, the first agent stops replaying the captured id, a restart reuses an
// id the store holds, and a recorded queued run leaks to another agent. 7-8: an
// agent an older runner build kept in the store hides its running run from a
// newer runner, or its id is given to a new agent.
const trace = (name: string) =>
	resolve(`test/fixtures/cursor-sdk-traces/${name}.jsonl`);
const capturedIds = (name: string) =>
	readFileSync(trace(name), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind?: string; data?: unknown })
		.flatMap(({ kind, data }) =>
			kind === "created" ? [(data as { agentId: string }).agentId] : [],
		);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const storeDir = () => {
	const root = mkdtempSync(join(tmpdir(), "cursor-trace-agents-"));
	roots.push(root);
	return root;
};
const credential = cursorCredentialFixture();
const optionsFor = (storePath: string): CursorAgentOptions => ({
	cwd: "/workspace",
	dirs: [],
	settingSources: [],
	storePath,
	sandboxOptions: { enabled: false },
	autoReview: false,
	tools: [],
	disallowedTools: [],
	customToolNames: [],
	subagentInherit: { reportedWorkspacePath: "/workspace" },
	credentialFingerprint: credential.fingerprint,
});
const open = async (name: string, storePath: string) => {
	const port = createTraceCursorSdkPort(trace(name));
	const store = await port.openStore(storePath, "/workspace");
	return {
		port,
		store,
		create: () => port.createAgent(optionsFor(storePath), credential, store),
		resume: (id: string) =>
			port.resumeAgent(id, optionsFor(storePath), credential, store),
		activeRun: (id: string) => port.getActiveRun(id, store),
	};
};

describe("trace player agent ids", () => {
	it("gives a new agent in a store that already holds one its own id and none of the old agent's runs", async () => {
		const replay = await open("basic", storeDir());
		const first = await replay.create();
		const run = await first.send(
			"hello",
			{ model: { id: "composer-2.5" }, mode: "agent" },
			() => {},
		);
		for await (const _ of run.stream);
		await run.wait();
		const earlier = await replay.activeRun(first.id);
		expect(earlier?.requestId).toEqual(expect.any(String));

		const next = await replay.create();
		expect(next.id).not.toBe(first.id);
		expect(await replay.activeRun(next.id)).toBeUndefined();
		// The resumed agent keeps its id and its own runs.
		const resumed = await replay.resume(first.id);
		expect(resumed.id).toBe(first.id);
		expect(await replay.activeRun(first.id)).toEqual(earlier);
	});

	it("replays the captured id for the first agent in each store", async () => {
		const [captured] = capturedIds("basic");
		for (const storePath of [storeDir(), storeDir()])
			expect((await (await open("basic", storePath)).create()).id).toBe(
				captured,
			);
	});

	it("replays two captured agents in recorded order, and a restart picks the same ids", async () => {
		const run = async () => {
			const stores = [storeDir(), storeDir()] as const;
			const first = await open("sandbox-primed", stores[0]);
			const ids = [
				(await first.create()).id,
				(
					await first.port.createAgent(
						optionsFor(stores[1]),
						credential,
						await first.port.openStore(stores[1], "/workspace"),
					)
				).id,
			];
			// A new runner process replays the trace from its first row again.
			const restarted = await open("sandbox-primed", stores[0]);
			ids.push((await restarted.create()).id);
			return ids;
		};
		const ids = await run();
		expect(ids.slice(0, 2)).toEqual(capturedIds("sandbox-primed").slice(0, 2));
		expect(new Set(ids).size).toBe(3);
		expect(await run()).toEqual(ids);
	});

	it("reads the agent an older runner build kept in the store, its running run and its id", async () => {
		const storePath = storeDir();
		const [captured = ""] = capturedIds("basic");
		const activeRun = { runId: "run-older", status: "running", requestId: "r" };
		writeFileSync(
			join(storePath, "trace-state.json"),
			JSON.stringify({
				id: captured,
				cwd: "/workspace",
				sendIndex: 1,
				activeRun,
			}),
		);
		const replay = await open("basic", storePath);
		expect(await replay.activeRun(captured)).toEqual(activeRun);
		expect((await replay.resume(captured)).id).toBe(captured);
		expect(await replay.activeRun(captured)).toEqual(activeRun);
		expect((await replay.create()).id).not.toBe(captured);
		await replay.port.deleteAgent(captured, "/workspace", replay.store);
		expect(await replay.activeRun(captured)).toBeUndefined();
	});

	it("reports a recorded queued run only for the agent it was recorded for", async () => {
		const replay = await open("never-sent", storeDir());
		const first = await replay.create();
		expect(await replay.activeRun(first.id)).toMatchObject({
			status: "queued",
		});
		const next = await replay.create();
		expect(next.id).not.toBe(first.id);
		expect(await replay.activeRun(next.id)).toBeUndefined();
	});
});
