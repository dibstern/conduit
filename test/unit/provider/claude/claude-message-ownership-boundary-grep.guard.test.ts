import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CORE = "src/lib/provider/claude/claude-message-ownership.ts";
const RUNTIME = "src/lib/provider/claude/claude-message-ownership-runtime.ts";

// Match calls, rather than dependency declarations or wiring that passes a
// function through. The runner command emit is also a lineage operation.
const LINEAGE_CALL =
	/\b(?:ensureClaudeSubagentSession|persistClaudeSubagent|materializeSubagents)\s*(?:\?\.)?\s*\(|\bemit\s*\(\s*\{\s*type:\s*["']ensure-subagent-session["']/g;
const CHILD_METADATA_WRITE =
	/\b\w*[Mm]etadata\s*[:=]\s*\{[^;]*?\bchildSessionId\b|\b\w*[Mm]etadata\s*(?:\.childSessionId|\[\s*["']childSessionId["']\s*\])\s*=|\bReflect\.set\(\s*\w*[Mm]etadata\s*,\s*["']childSessionId["']/g;

// Pin each permitted call and metadata write by site and count. Declarations
// and transport wiring do not invoke operations.
const IMPLEMENTATION_CALLS = [
	{
		file: "src/lib/provider/claude/claude-runner-payload.ts",
		calls: ['emit({ type: "ensure-subagent-session"'],
		// Runner transport emits only the ownership module's lineage command.
	},
	{
		file: "src/lib/provider/cursor/cursor-runner-payload.ts",
		calls: ['emit({ type: "ensure-subagent-session"'],
		// Cursor uses the same runner materialization command as Claude.
	},
	{
		file: "src/lib/provider/cursor/cursor-turn-events.ts",
		calls: [],
		childMetadataWrites: ["metadata: { childSessionId"],
		// The Task translator owns Cursor child identity and its tool link.
	},
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const file = join(dir, entry);
		return statSync(file).isDirectory()
			? sourceFiles(file)
			: /\.(?:ts|svelte)$/.test(file)
				? [file]
				: [];
	});
}

describe("Provider Child Session ownership boundary", () => {
	it("confines lineage operations and child tool metadata to their provider owner", () => {
		for (const { file } of IMPLEMENTATION_CALLS)
			expect(statSync(join(ROOT, file)).isFile(), file).toBe(true);
		const outside = sourceFiles(join(ROOT, "src")).flatMap((file) => {
			const path = relative(ROOT, file);
			if (path === CORE || path === RUNTIME) return [];
			const source = readFileSync(file, "utf8");
			const calls = [...source.matchAll(LINEAGE_CALL)].map((match) =>
				match[0].replace(/\s+/g, " "),
			);
			const allowed = IMPLEMENTATION_CALLS.find((site) => site.file === path);
			const violations: { path: string; source: string }[] = [];
			if (
				JSON.stringify(calls.sort()) !==
				JSON.stringify([...(allowed?.calls ?? [])].sort())
			) {
				violations.push({ path, source: calls.join(", ") });
			}
			const metadataWrites = [...source.matchAll(CHILD_METADATA_WRITE)].map(
				(match) => match[0].replace(/\s+/g, " "),
			);
			if (
				JSON.stringify(metadataWrites.sort()) !==
				JSON.stringify([...(allowed?.childMetadataWrites ?? [])].sort())
			) {
				violations.push({ path, source: metadataWrites.join(", ") });
			}
			return violations;
		});
		expect(
			outside,
			`Claude Child Session lineage and tool links belong to ${RUNTIME}, driven by ${CORE}. Transport and persistence only carry out its commands. See ADR-0004 and conduit-test-i7fy.3.`,
		).toEqual([]);
	});

	it("keeps the module responsible for opening children, lineage, and tool links", () => {
		const core = readFileSync(join(ROOT, CORE), "utf8");
		const runtime = readFileSync(join(ROOT, RUNTIME), "utf8");
		expect(core.match(/kind:\s*"open-child"/g)?.length ?? 0).toBeGreaterThan(1);
		expect(runtime).toMatch(/ensureClaudeSubagentSession\(/);
		expect(runtime.match(CHILD_METADATA_WRITE)?.length ?? 0).toBeGreaterThan(0);
	});
});
