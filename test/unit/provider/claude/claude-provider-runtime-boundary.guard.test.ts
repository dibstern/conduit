import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const CLAUDE_PROVIDER_DIR = "src/lib/provider/claude";

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("Claude provider runtime boundary", () => {
	it("wires the persisted override getter into the scoped constructor", () => {
		const wiring = source(
			"src/lib/domain/daemon/Layers/provider-adapters-layer.ts",
		);
		const getters = wiring.match(
			/claudeSettingsOverrides: \(\) =>\s*loadRelaySettings\(configDir\)\.claudeSettings/g,
		);

		expect(getters).toHaveLength(1);
	});

	it("keeps live Claude turn state out of the provider instance facade", () => {
		const providerInstance = source(
			`${CLAUDE_PROVIDER_DIR}/claude-provider-instance.ts`,
		);

		expect(providerInstance).toContain("ClaudeProviderRuntime");
		expect(providerInstance).not.toContain("sessions = new Map");
		expect(providerInstance).not.toContain("sessionLocks");
		expect(providerInstance).not.toContain("turnDeferredQueues");
		expect(providerInstance).not.toContain("endedSessionStreams");
	});

	it("keeps Claude runtime state Effect-owned", () => {
		const runtime = source(`${CLAUDE_PROVIDER_DIR}/claude-provider-runtime.ts`);

		expect(runtime).toContain("ClaudeProviderRuntimeTag");
		expect(runtime).toContain("Ref.Ref<ClaudeProviderRuntimeState>");
		expect(runtime).toContain("HashMap.HashMap<string, ClaudeSessionContext>");
		expect(runtime).toContain("FiberMap.FiberMap<string");
		expect(runtime).not.toContain("streamConsumer");
	});

	it("removes stream consumer promises from session context", () => {
		const types = source(`${CLAUDE_PROVIDER_DIR}/types.ts`);

		expect(types).not.toContain("streamConsumer");
	});
});
