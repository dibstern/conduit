import type { Socket } from "node:net";
import type { Effect } from "effect";
import { type RunnerMessage, RunnerSocket } from "../runner/runner-protocol.js";
import type { SessionFailure } from "../runner/session-runner.js";
import { makeClaudeRunnerWire } from "./claude-runner-wire.js";
import type { ClaudeLaunchConfig } from "./claude-sdk-env.js";

/** Preserve the legacy constructor while the wire adaptation stays provider-owned. */
export class ClaudeRunnerSocket extends RunnerSocket {
	constructor(
		socket: Socket,
		onMessage: (message: RunnerMessage) => void,
		onClose: (failure: SessionFailure) => void,
		beforeCommandFailure?: () => Effect.Effect<void>,
		defaultFolder?: () => ClaudeLaunchConfig,
	) {
		super(
			socket,
			onMessage,
			onClose,
			beforeCommandFailure,
			makeClaudeRunnerWire(defaultFolder),
		);
	}
}
