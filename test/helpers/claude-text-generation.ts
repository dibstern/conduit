import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
	type ClaudeOneShotQueryFactory,
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../src/lib/provider/claude/claude-provider-runtime.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../src/lib/provider/provider-registry.js";

// Replay complete captured envelopes unchanged, including partials and results.
// See ADR-0002. Transport failures and delays are injected by the caller.
export async function* replayClaudeText(
	trace = "pong-thinking-text-turn",
): AsyncIterable<unknown> {
	const raw = readFileSync(
		join(
			import.meta.dirname,
			"../fixtures/claude-sdk-traces",
			`${trace}.jsonl`,
		),
		"utf8",
	);
	for (const line of raw.trim().split("\n")) {
		yield JSON.parse(line) as unknown;
	}
}

export const makeClaudeTextGenerationLayer = (
	queryFactory: ClaudeOneShotQueryFactory,
	configDir?: string,
) =>
	Layer.effect(
		ProviderRegistryTag,
		Effect.gen(function* () {
			const daemonConfigDir =
				configDir ??
				(yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-title-sdk-"))),
					(dir) =>
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				));
			const provider = yield* makeClaudeProviderRuntime({
				daemonConfigDir,
				runnerFactory: makeClaudeSessionRunner,
				generateTextQueryFactory: queryFactory,
			});
			return new ProviderRegistry([provider]);
		}),
	);
