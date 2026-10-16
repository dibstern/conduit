import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import type { ProviderDriver } from "../types.js";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeProviderRuntime,
} from "./claude-provider-runtime.js";

export { RunnerProviderInstance as ClaudeProviderInstance } from "../runner/runner-provider-instance.js";
export type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";

export const ClaudeDriver: ProviderDriver<ClaudeProviderInstanceDeps> = {
	providerId: "claude",
	capabilities: PROVIDER_DRIVERS.claude.capabilities,
	create: makeClaudeProviderRuntime,
};
