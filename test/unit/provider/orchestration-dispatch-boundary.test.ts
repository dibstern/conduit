import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const HANDLER_FILES = [
	"src/lib/bridges/client-init.ts",
	"src/lib/handlers/context-window.ts",
	"src/lib/handlers/model.ts",
	"src/lib/handlers/prompt.ts",
	"src/lib/handlers/reload.ts",
	"src/lib/handlers/settings.ts",
] as const;

describe("orchestration dispatch boundary", () => {
	it("runtime code uses Effect dispatch instead of the Promise facade", () => {
		const offenders = HANDLER_FILES.flatMap((file) => {
			const source = readFileSync(join(REPO_ROOT, file), "utf8");
			return source.includes(".dispatch(") ? [file] : [];
		});

		expect(offenders).toEqual([]);
	});

	it("provider registry exposes only the Effect shutdown boundary", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/provider-registry.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/(?:^|\n)\s*(?:async\s+)?shutdownAll\s*\(/);
		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)\s*\(/);
	});

	it("orchestration engine exposes only the Effect shutdown boundary", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/orchestration-engine.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/(?:^|\n)\s*(?:async\s+)?shutdown\s*\(/);
		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)\s*\(/);
	});

	it("orchestration engine does not keep authoritative processed-command caches", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/orchestration-engine.ts"),
			"utf8",
		);

		expect(source).not.toContain("processedCommands");
		expect(source).not.toContain("PROCESSED_COMMANDS_MAX");
		expect(source).not.toContain("IdempotencySetTag");
	});

	it("relay stop lets the scoped runtime own orchestration shutdown", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/relay/relay-stack.ts"),
			"utf8",
		);

		expect(source).not.toContain("orchestration.engine.shutdown");
		expect(source).not.toContain("orchestration.engine.shutdownEffect");
		expect(source).not.toContain("Layer.succeed(OrchestrationEngineTag");
	});
});
