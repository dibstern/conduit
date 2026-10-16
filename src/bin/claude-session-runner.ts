#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { makeClaudeRunnerLaunch } from "../lib/provider/claude/claude-runner-launch.js";
import { runSessionRunner } from "../lib/provider/runner/runner-host.js";

const main = Effect.gen(function* () {
	const driverKind = process.argv[6] ?? "claude";
	if (driverKind !== "claude")
		return yield* Effect.fail(
			new Error(`Unknown runner driver kind: ${driverKind}`),
		);
	return yield* runSessionRunner(driverKind, makeClaudeRunnerLaunch);
});

NodeRuntime.runMain(Effect.scoped(main));
