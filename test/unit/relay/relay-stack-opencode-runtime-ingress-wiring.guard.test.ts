import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Relay stack Effect OpenCode runtime ingress wiring", () => {
	it("does not construct the legacy OpenCodeRuntimeIngress fallback", () => {
		const source = [
			"src/lib/relay/project-relay-layers.ts",
			"src/lib/relay/project-relay-startup.ts",
		]
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(source).not.toContain("new OpenCodeRuntimeIngress");
		expect(source).toContain("makeEffectOpenCodeRuntimeIngress");
		expect(source).toContain("ProviderRuntimeIngestionLive");
	});
});
