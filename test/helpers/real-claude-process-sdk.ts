import { query } from "@anthropic-ai/claude-agent-sdk";
import { defaultClaudeSessionForkSdk } from "../../src/lib/provider/claude/claude-session-fork.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { claudeSdk as fakeClaudeSdk } from "./fake-claude-process-sdk.js";

type Query = ReturnType<typeof query>;

/** The real query with its interrupt acknowledged but never sent, as a Claude that ignores Stop (8.4). */
const deafQuery = (params: Parameters<typeof query>[0]): Query =>
	new Proxy(query(params), {
		get: (target, key) => {
			if (key === "interrupt") return () => Promise.resolve();
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query:
		process.env["CONDUIT_TEST_REAL_CLAUDE_DEAF_INTERRUPT"] === "1"
			? deafQuery
			: query,
	titleQuery: fakeClaudeSdk.titleQuery,
	fork: defaultClaudeSessionForkSdk,
};
