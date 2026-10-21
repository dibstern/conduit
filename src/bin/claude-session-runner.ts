#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { makeClaudeRunnerLaunch } from "../lib/provider/claude/claude-runner-launch.js";
import { makeCursorRunnerLaunch } from "../lib/provider/cursor/cursor-runner-launch.js";
import { runSessionRunner } from "../lib/provider/runner/runner-host.js";

/** The payload each runner-backed driver launches. */
const launches = new Map<string, typeof makeClaudeRunnerLaunch>([
	["claude", makeClaudeRunnerLaunch],
	["cursor", makeCursorRunnerLaunch],
]);

const main = Effect.gen(function* () {
	const driverKind = process.argv[6] ?? "claude";
	const launch = launches.get(driverKind);
	if (!launch)
		return yield* Effect.fail(
			new Error(`Unknown runner driver kind: ${driverKind}`),
		);
	return yield* runSessionRunner(driverKind, launch);
});

NodeRuntime.runMain(Effect.scoped(main));
