// Removal must stop only the admitted account's actual runner work, even after
// send intake has replied and the idle grace has elapsed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const evidence: Record<string, unknown>[] = [];
afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	if (task.result?.errors?.length)
		writeFileSync(
			`/tmp/82tn9-4-process-${task.name.includes("prompt") ? "prompt" : task.name.includes("background") ? "background" : "turn"}.log`,
			fixture.logTail,
		);
	await fixture.dispose();
	expect(fixture.remainingRunnerPids()).toEqual([]);
	evidence.push({
		name: task.name,
		result: task.result?.state,
		cleanup: fixture.proof().runnerCleanup,
		remaining: fixture.remainingRunnerPids(),
	});
	writeFileSync(
		"/tmp/82tn9-4-claude-process-scopes.json",
		JSON.stringify(evidence, null, 2),
	);
	harness = undefined;
});

it.each([
	"turn",
	"prompt",
	"background",
] as const)("removing A cancels its %s and leaves B running", async (work) => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart({ opencodeIdleTimeoutMs: 50 });
	const browser = await fixture.connect();
	const folder = join(fixture.root, "shared-login");
	mkdirSync(folder);
	const accounts: string[] = [];
	for (const name of ["A", "B"]) {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			driver: "claude",
			name,
			configDir: folder,
			env: { ACCOUNT_OWNER: name },
		});
		if (!added.addedInstanceId) throw new Error("Missing fixture account");
		accounts.push(added.addedInstanceId);
	}
	const [a, b] = accounts;
	if (!a || !b) throw new Error("Missing fixture accounts");
	const sessionA = await browser.createSession("Scope A", a);
	const sessionB = await browser.createSession("Scope B", b);
	const submit = (sessionId: string, text: string) =>
		Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text,
			}),
		);
	const cursor = browser.frames.length;
	await submit(
		sessionA,
		work === "turn"
			? "load-stream-scope-a"
			: work === "prompt"
				? "approval-rebind-scope"
				: "upgrade-background-work",
	);
	if (work === "prompt")
		await browser.waitFor(
			(frame) => frame["type"] === "permission_pending",
			cursor,
		);
	if (work === "background")
		await vi.waitFor(
			() =>
				expect(
					readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8"),
				).toContain('"kind":"background-work"'),
			{ timeout: 10_000 },
		);
	await submit(sessionB, "load-stream-scope-b");
	const runners = () => discoverRunners(fixture.projectDir, fixture.configDir);
	await vi.waitFor(
		() =>
			expect(runners().some((runner) => runner.sessionId === sessionB)).toBe(
				true,
			),
		{ timeout: 10_000 },
	);
	await vi.waitFor(
		() =>
			expect(
				readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8"),
			).toContain('"request":"load-stream-scope-b"'),
		{ timeout: 10_000 },
	);
	// Cross several grace windows while foreground, prompts, or background own A.
	await new Promise<void>((done) => setTimeout(done, 200));
	const before = runners();
	expect(before.some((runner) => runner.sessionId === sessionA)).toBe(true);
	if (work !== "turn") {
		await fixture.kill();
		await fixture.restart();
		await fixture.connect(sessionA);
	}
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: a });
	await vi.waitFor(
		() =>
			expect(runners().some((runner) => runner.sessionId === sessionA)).toBe(
				false,
			),
		{ timeout: 5_000 },
	);
	expect(
		runners().find((runner) => runner.sessionId === sessionB)?.runnerId,
	).toBe(before.find((runner) => runner.sessionId === sessionB)?.runnerId);
	evidence.push({ work, accounts, before, after: runners() });
}, 60_000);

it("reopens account resources after idle grace while A B A keeps its session controller", async () => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart({ opencodeIdleTimeoutMs: 50 });
	const browser = await fixture.connect();
	const folder = join(fixture.root, "shared-login");
	mkdirSync(folder);
	const accounts: string[] = [];
	for (const name of ["A", "B"]) {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			driver: "claude",
			name,
			configDir: folder,
			env: { ACCOUNT_OWNER: name },
		});
		if (!added.addedInstanceId) throw new Error("Missing fixture account");
		accounts.push(added.addedInstanceId);
	}
	const [a, b] = accounts;
	if (!a || !b) throw new Error("Missing fixture accounts");
	const sessionId = await browser.createSession("Idle account resources", a);
	const controllers: string[] = [];
	for (const [index, account] of [a, b, a].entries()) {
		if (index > 0)
			await fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId,
				instanceId: account,
				expectedInstanceId: index === 1 ? a : b,
			});
		await browser.send(sessionId, `idle-scope-${index}`);
		const controller = discoverRunners(
			fixture.projectDir,
			fixture.configDir,
		).find((runner) => runner.sessionId === sessionId);
		if (!controller) throw new Error("Missing fixture controller");
		controllers.push(controller.runnerId);
		await new Promise<void>((done) => setTimeout(done, 200));
	}
	expect(new Set(controllers).size).toBe(1);
	expect(
		fixture.claudeOptions().map(({ options }) => {
			const env = options["env"];
			return env && typeof env === "object" && "ACCOUNT_OWNER" in env
				? env.ACCOUNT_OWNER
				: undefined;
		}),
	).toEqual(["A", "B", "A"]);
	evidence.push({ sessionId, controllers, owners: ["A", "B", "A"] });
}, 60_000);

it("removing an account cancels its provided-model prewarm during SDK initialization", async () => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		queryInitializationDelayMs: 3_000,
	});
	harness = fixture;
	await fixture.restart({ opencodeIdleTimeoutMs: 50 });
	const browser = await fixture.connect();
	const folder = join(fixture.root, "warming-login");
	mkdirSync(folder);
	const added = await fixture.requestRpc({
		_tag: "AddInstance",
		driver: "claude",
		name: "Warming",
		configDir: folder,
		env: { ACCOUNT_OWNER: "warming" },
	});
	const account = added.addedInstanceId;
	if (!account) throw new Error("Missing fixture account");
	const sessionId = await browser.createSession(
		"Remove warming account",
		account,
	);
	const warming = browser.preWarmSession(sessionId).then(
		() => "completed",
		() => "cancelled",
	);
	await vi.waitFor(
		() =>
			expect(fixture.marks.some((mark) => mark.kind === "query")).toBe(true),
		{
			timeout: 10_000,
		},
	);
	expect(
		fixture.marks.filter((mark) => mark.kind === "initialization-ready"),
	).toHaveLength(0);
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: account });
	await warming;
	await vi.waitFor(
		() =>
			expect(
				discoverRunners(fixture.projectDir, fixture.configDir).some(
					(runner) => runner.sessionId === sessionId,
				),
			).toBe(false),
		{ timeout: 5_000 },
	);
	evidence.push({
		sessionId,
		account,
		phaseAtRemoval: "SDK initialization",
		runners: discoverRunners(fixture.projectDir, fixture.configDir),
	});
}, 60_000);

it.each([
	"another account remains",
	"no accounts remain",
	"retry after warm failure",
] as const)("removing an account cancels its warming runner replacement when %s", async (remaining) => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart({
		buildId: "account-scope-old",
		opencodeIdleTimeoutMs: 50,
	});
	const browser = await fixture.connect();
	const folder = join(fixture.root, "upgrade-login");
	mkdirSync(folder);
	await fixture.requestRpc({
		_tag: "UpdateInstance",
		instanceId: "claude",
		configDir: folder,
	});
	const sessionId = await browser.createSession(
		"Remove upgrading account",
		"claude",
	);
	await browser.send(sessionId, "before-account-removal");
	const old = discoverRunners(fixture.projectDir, fixture.configDir).find(
		(runner) => runner.sessionId === sessionId,
	);
	if (!old) throw new Error("Missing old runner");
	let sessionB: string | undefined;
	if (remaining !== "no accounts remain") {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			driver: "claude",
			name: "B",
			configDir: folder,
		});
		if (!added.addedInstanceId) throw new Error("Missing account B");
		sessionB = await browser.createSession(
			"Unaffected account B",
			added.addedInstanceId,
		);
	}
	await fixture.kill();
	const retry = remaining === "retry after warm failure";
	writeFileSync(
		join(
			fixture.root,
			retry ? "fail-next-initialization" : "hold-next-initialization",
		),
		"once",
	);
	await fixture.restart({ buildId: "account-scope-new" });
	const resumed = await fixture.connect(sessionId);
	const marks = (): ProcessMark[] =>
		readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProcessMark);
	if (retry) {
		await vi.waitFor(
			() =>
				expect(
					marks().some(
						(mark) => mark.kind === "runner-upgrade" && mark.phase === "failed",
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		writeFileSync(join(fixture.root, "hold-next-initialization"), "hold retry");
		await resumed.send(sessionId, "retry-after-warm-failure");
	}
	await vi.waitFor(
		() =>
			expect(marks().some((mark) => mark.kind === "initialization-held")).toBe(
				true,
			),
		{ timeout: 10_000 },
	);
	const held = marks().find((mark) => mark.kind === "initialization-held");
	const candidate = marks().find(
		(mark) =>
			mark.kind === "query" &&
			held?.kind === "initialization-held" &&
			mark.queryId === held.queryId,
	);
	if (candidate?.kind !== "query")
		throw new Error("Missing warming account replacement");
	expect(
		marks().some(
			(mark) =>
				mark.kind === "initialization-held" &&
				mark.queryId === candidate.queryId,
		),
	).toBe(true);
	// More than one idle grace elapses while the replacement is initializing.
	await new Promise<void>((done) => setTimeout(done, 200));
	if (remaining === "no accounts remain") {
		const { instances } = await fixture.requestRpc({ _tag: "GetInstances" });
		for (const instance of instances ?? [])
			if (instance.id !== "claude")
				await fixture.requestRpc({
					_tag: "RemoveInstance",
					instanceId: instance.id,
				});
	}
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: "claude" });
	await vi.waitFor(
		() => {
			expect(
				marks().some(
					(mark) =>
						mark.kind === "query-closed" && mark.queryId === candidate.queryId,
				),
			).toBe(true);
			expect(() => process.kill(candidate.pid, 0)).toThrow();
			expect(() => process.kill(old.pid, 0)).toThrow();
		},
		{ timeout: 5_000 },
	);
	writeFileSync(join(fixture.root, "release-held-initialization"), "release");
	await new Promise<void>((done) => setTimeout(done, 200));
	expect(
		marks().some(
			(mark) =>
				mark.kind === "runner-upgrade" &&
				mark.phase === "switched" &&
				mark.newPid === candidate.pid,
		),
	).toBe(false);
	if (sessionB) await resumed.send(sessionB, "account-b-after-removal");
	else
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances,
		).toEqual([]);
	evidence.push({ sessionId, remaining, old, candidate, marks: marks() });
}, 60_000);
