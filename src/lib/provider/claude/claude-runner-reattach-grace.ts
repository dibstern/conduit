/** A disconnected runner survives brief restarts, but never waits forever. */
export class ClaudeRunnerReattachGrace {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly durationMs: number;

	constructor(private readonly expire: () => void) {
		const configured = Number(
			process.env["CONDUIT_CLAUDE_RUNNER_REATTACH_GRACE_MS"],
		);
		this.durationMs =
			Number.isSafeInteger(configured) &&
			configured > 0 &&
			configured <= 2_147_483_647
				? configured
				: 60_000;
	}

	disconnected(): void {
		// Rejected connections cannot extend an existing grace period.
		if (this.timer) return;
		this.timer = setTimeout(this.expire, this.durationMs);
		this.timer.unref();
	}

	reattached(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
