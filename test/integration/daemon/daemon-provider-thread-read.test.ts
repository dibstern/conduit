import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure modes: a shared adapter loses history access, captures one project's
// reader, keeps a disposed borrow, or recovers a runner without its reader.
it("routes Claude thread reads by session across projects, recovery and removal", async () => {
	const evidence: Record<string, unknown> = { passed: false };
	const harness = ProcessHarness.create({
		restartProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
	});
	try {
		const probeConfig = join(harness.root, "thread-read-proof.json");
		writeFileSync(
			probeConfig,
			JSON.stringify({ sessionId: "", projectId: "process-test" }),
		);
		await harness.restart();
		const projectB = join(harness.root, "project-b");
		mkdirSync(projectB);
		await harness.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		let a = await harness.connect();
		let b = await harness.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Project A history");
		const sessionB = await b.createSession("Project B history");
		const seedA = "history-owned-by-project-a";
		const seedB = "history-owned-by-project-b";
		await a.send(sessionA, seedA);
		await b.send(sessionB, seedB);
		writeFileSync(
			probeConfig,
			JSON.stringify({ sessionId: sessionA, projectId: "process-test" }),
		);
		const runnerPids = harness.marks
			.filter((mark) => mark.kind === "runner-started")
			.map((mark) => mark.pid);
		const reads: Record<string, unknown>[] = [];
		// Retained runners lose their original parent's IPC connection at restart.
		const marks = () =>
			readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as ProcessMark);
		evidence["sessions"] = { sessionA, sessionB };
		evidence["runnerPids"] = runnerPids;
		evidence["reads"] = reads;
		const readHistory = async (
			browser: typeof a,
			sessionId: string,
			ownSeed: string,
			otherSeed: string,
			phase: string,
		) => {
			const cursor = marks().length;
			const turn = await browser.send(sessionId, "thread-read-omitted-history");
			const calls = marks()
				.slice(cursor)
				.filter(
					(mark): mark is Extract<ProcessMark, { kind: "mcp-tool-call" }> =>
						mark.kind === "mcp-tool-call",
				);
			reads.push({ phase, sessionId, calls, turn });
			expect(calls.length).toBeGreaterThan(0);
			const pages = calls.filter(
				(call) => call.arguments["cursor"] !== "invalid-thread-cursor",
			);
			for (const page of pages) expect(page.result.isError).not.toBe(true);
			const text = JSON.stringify(pages.map((page) => page.result.content));
			expect(text).toContain(ownSeed);
			expect(text).not.toContain(otherSeed);
			expect(calls.at(-1)?.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.stringContaining("BadCursor") }],
			});
			expect(turn.chunks.join("")).toBe(
				responseChunks("thread-read-omitted-history").join(""),
			);
		};
		await readHistory(a, sessionA, seedA, seedB, "before-restart-a");
		await readHistory(b, sessionB, seedB, seedA, "before-restart-b");
		await harness.kill();
		await harness.restart();
		// Recovery attaches retained runners during startup, before any browser
		// reconnects, with project borrows registered by the recovery barrier.
		a = await harness.connect(sessionA);
		b = await harness.connect(sessionB, undefined, "project-b");
		for (const pid of runnerPids)
			expect(() => process.kill(pid, 0)).not.toThrow();
		await readHistory(b, sessionB, seedB, seedA, "after-restart-b");
		await readHistory(a, sessionA, seedA, seedB, "after-restart-a");
		// The fixture invokes the real callback before borrowing project services,
		// and with A temporarily unregistered while its runner remains attached.
		const probes = readFileSync(
			join(harness.root, "thread-read-probes.ndjson"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; result: unknown });
		evidence["probes"] = probes;
		expect(probes.filter(({ kind }) => kind === "before-borrow")).toHaveLength(
			1,
		);
		expect(
			probes.filter(({ kind }) => kind === "missing-project"),
		).toHaveLength(2);
		for (const { result } of probes)
			expect(result).toEqual({
				code: "ServerUnavailable",
				message: "This Conduit session's project is unavailable.",
			});
		for (const pid of runnerPids)
			expect(() => process.kill(pid, 0)).not.toThrow();
		await harness.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		await readHistory(b, sessionB, seedB, seedA, "after-removal-b");
		evidence["passed"] = true;
	} finally {
		await harness.dispose();
		evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
		writeFileSync(
			"/tmp/82tn9-7-fix2-thread-read-e2e.json",
			JSON.stringify(evidence, null, 2),
		);
	}
}, 90_000);
