import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Relay stack Effect OpenCode runtime ingress wiring", () => {
	it("does not construct the legacy OpenCodeRuntimeIngress fallback", () => {
		const source = [
			"src/lib/domain/daemon/Layers/project-services-layer.ts",
			"src/lib/domain/daemon/Layers/project-startup.ts",
			// The project builds its ingress and ingestion (82tn.16).
			"src/lib/domain/relay/Layers/project-ingestion-layer.ts",
		]
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(source).not.toContain("new OpenCodeRuntimeIngress");
		expect(source).toContain("makeEffectOpenCodeRuntimeIngress");
		expect(source).toContain("ProviderRuntimeIngestionLive");
	});
});
