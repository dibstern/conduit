// Failure modes: empty titles use the expensive provider default, explicit
// choices lose native values, or stale choices reach the CLI instead of failing.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { discoverCodex } from "../../../../src/lib/provider/codex/codex-discovery.js";
import { generateCodexText } from "../../../../src/lib/provider/codex/codex-text-generation.js";

vi.mock("../../../../src/lib/provider/codex/codex-home.js", async () => {
	const { Effect } = await import("effect");
	return {
		prepareCodexAccount: () => Effect.succeed({ home: "/unused", env: {} }),
	};
});
vi.mock("../../../../src/lib/provider/codex/codex-discovery.js", () => ({
	discoverCodex: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFile: vi.fn(
		(
			_binary: string,
			argv: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			const output = argv[argv.indexOf("--output-last-message") + 1];
			if (argv[0] === "exec" && output) writeFileSync(output, "Short title");
			callback(null, "[]");
			return { stdin: { end: vi.fn() } };
		},
	),
}));

const roots: string[] = [];
const input = {
	account: {
		driver: "codex" as const,
		id: AccountIdSchema.make("codex-title"),
		name: "Codex",
		usageEligible: false,
		env: {},
	},
	model: { providerId: "codex", modelId: "gpt-test" },
	effort: "",
	instructions: "Return a title",
	prompt: "Fix it",
};
function setup() {
	const root = mkdtempSync(join(tmpdir(), "codex-choice-"));
	roots.push(root);
	vi.mocked(discoverCodex).mockReturnValue(
		Effect.succeed({
			signedIn: true,
			skills: [],
			models: [
				{
					id: "gpt-test",
					name: "GPT",
					providerId: "codex",
					parameters: {
						rows: [
							{
								id: "effort",
								label: "Effort",
								values: [
									{ value: "low", label: "Low" },
									{ value: "high", label: "High" },
								],
							},
						],
						combinations: [
							{
								variant: "High effort",
								values: { effort: "high" },
								isDefault: true,
							},
							{ variant: "Low effort", values: { effort: "low" } },
						],
					},
				},
			],
		}),
	);
	return root;
}
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("Codex title parameter choices", () => {
	it.each([
		["", "low"],
		["High effort", "high"],
	])("resolves %j to native effort %s", async (effort, expected) => {
		const root = setup();
		expect(
			await Effect.runPromise(generateCodexText({ ...input, effort }, root)),
		).toBe("Short title");
		const invocation = vi
			.mocked(execFile)
			.mock.calls.find(
				(call) => Array.isArray(call[1]) && call[1][0] === "exec",
			);
		expect(invocation?.[1]).toContain(`model_reasoning_effort="${expected}"`);
	});
	it("surfaces a stale choice before invoking the CLI", async () => {
		const root = setup();
		const result = await Effect.runPromise(
			Effect.result(generateCodexText({ ...input, effort: "removed" }, root)),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: {
				cause: {
					_tag: "ModelParametersUnavailable",
					choice: "removed",
					reason: "not-offered",
				},
			},
		});
		expect(execFile).not.toHaveBeenCalled();
	});
});
