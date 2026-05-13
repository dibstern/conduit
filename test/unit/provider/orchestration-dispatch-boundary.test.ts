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

		expect(source).not.toContain("shutdownAll(): Promise");
		expect(source).not.toContain("Effect.runPromise(this.shutdownAllEffect())");
	});
});
