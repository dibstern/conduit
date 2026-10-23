// Failure cases: content lookup guesses another provider/account's roots,
// exposes filesystem paths as refs, or leaves fixture-owned runners alive.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;

function writeSkill(directory: string, name: string, instructions: string) {
	mkdirSync(directory, { recursive: true });
	const content = `---\nname: ${name}\ndescription: ${name} instructions\n---\n${instructions}\n`;
	const path = join(directory, "SKILL.md");
	writeFileSync(path, content);
	return { path, content };
}

describe("Skill locations through daemon browser RPC", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	function create(name: string) {
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({
			rootPrefix: join(tmpdir(), "conduit-skill-location-"),
		});
		return harness;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/c6-skill-location-${scenario}.json`,
				`${JSON.stringify(
					{
						...evidence,
						result: task.result?.state,
						errors: task.result?.errors?.map(({ message }) => message) ?? [],
						remainingRunnerPids: fixture.remainingRunnerPids(),
						rpcDecodeFailures: proof.rpcDecodeFailures,
						...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
					},
					null,
					2,
				).replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
		}
	}, TIMEOUT);

	it(
		"opens a Cursor skill's own SKILL.md using the skills chip RPC",
		async () => {
			const fixture = create("cursor");
			const name = "cursor-review";
			const expected = writeSkill(
				join(fixture.projectDir, ".cursor", "skills", name),
				name,
				"Read the Cursor-specific review instructions.",
			);
			const rows = readFileSync(
				resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
				"utf8",
			)
				.split("\n")
				.filter(Boolean)
				.map((line): { kind?: string; data?: unknown } => JSON.parse(line));
			rows.splice(1, 0, {
				kind: "credential.store",
				data: {
					apiKey: "[REDACTED]",
					backendUrl: "https://api2.cursor.sh",
					createdAtMs: 0,
				},
			});
			const replay = join(fixture.root, "cursor-replay.jsonl");
			writeFileSync(
				replay,
				`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
			await fixture.restart({
				startupTimeoutMs: TIMEOUT,
				serviceEnvironment: { CONDUIT_CURSOR_SDK_TRACE: replay },
			});
			const { addedInstanceId } = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "Cursor skill account",
				driver: "cursor",
			});
			if (!addedInstanceId) throw new Error("Missing Cursor account");
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Cursor skill content",
				addedInstanceId,
				"cursor",
				{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
			);
			const { commands } = await Effect.runPromise(
				browser.rpc.GetCommands({ sessionId }),
			);
			const command = commands.find((command) => command.name === name);
			expect(command).toBeDefined();
			const skillRef = (command as { readonly skillRef?: string } | undefined)
				?.skillRef;
			evidence = { command, expected };
			if (!skillRef) throw new Error("Discovered Cursor skill has no skillRef");
			const opened = await Effect.runPromise(
				browser.rpc.GetSkillContent({ sessionId, skillRef }),
			);
			evidence["opened"] = opened;
			expect(opened).toMatchObject({ name, ...expected });
			expect(skillRef).toEqual(expect.any(String));
			expect(skillRef).not.toContain(fixture.root);
			expect(fixture.proof().rpcDecodeFailures).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"opens the selected Claude account's skill instead of HOME's same-named skill",
		async () => {
			const fixture = create("claude-account");
			const name = "account-review";
			const account = join(fixture.root, "custom-claude-account");
			const expected = writeSkill(
				join(account, "skills", name),
				name,
				"Use the selected Claude account's review instructions.",
			);
			const shadow = writeSkill(
				join(fixture.root, "home", ".claude", "skills", name),
				name,
				"Do not use these default HOME instructions for this account.",
			);
			await fixture.restart({ startupTimeoutMs: TIMEOUT });
			const { addedInstanceId } = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "Custom Claude account",
				driver: "claude",
				configDir: account,
			});
			if (!addedInstanceId) throw new Error("Missing Claude account");
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Account skill content",
				addedInstanceId,
			);
			const { commands } = await Effect.runPromise(
				browser.rpc.GetCommands({ sessionId }),
			);
			const command = commands.find((command) => command.name === name);
			expect(command).toBeDefined();
			const skillRef = (command as { readonly skillRef?: string } | undefined)
				?.skillRef;
			evidence = { command, expected, shadow };
			if (!skillRef) throw new Error("Discovered Claude skill has no skillRef");
			const opened = await Effect.runPromise(
				browser.rpc.GetSkillContent({ sessionId, skillRef }),
			);
			evidence["opened"] = opened;
			expect(opened).toMatchObject({ name, ...expected });
			expect(opened.content).not.toBe(shadow.content);
			expect(skillRef).toEqual(expect.any(String));
			expect(skillRef).not.toContain(fixture.root);
			expect(fixture.proof().rpcDecodeFailures).toEqual([]);
		},
		TIMEOUT,
	);
});
