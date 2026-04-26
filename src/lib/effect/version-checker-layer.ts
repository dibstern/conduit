// ─── VersionChecker Effect Layer ────────────────────────────────────────────
// Pure Effect replacement for the VersionChecker class.
// Periodically checks for newer versions and broadcasts update notifications.
// Background fiber is fork-scoped — automatically interrupted on scope close.
//
// Defines its own Tag that will coexist with the one in services.ts until
// Phase 3 consumer migration.

import { Context, type Duration, Effect, Layer, Ref, Schedule } from "effect";

// ─── Config ─────────────────────────────────────────────────────────────────

interface VersionCheckerConfig {
	getCurrentVersion: () => string;
	fetchLatestVersion: () => Effect.Effect<string | null>;
	broadcast: (msg: {
		type: string;
		current: string;
		latest: string;
	}) => Effect.Effect<void>;
	checkInterval: Duration.DurationInput;
}

// ─── Service interface ──────────────────────────────────────────────────────

interface VersionCheckerService {
	getLatestKnown: () => Effect.Effect<string | null>;
	getCurrentVersion: () => Effect.Effect<string>;
}

// ─── Tag ────────────────────────────────────────────────────────────────────

export class VersionCheckerTag extends Context.Tag("VersionChecker")<
	VersionCheckerTag,
	VersionCheckerService
>() {}

// ─── Semver comparison ──────────────────────────────────────────────────────

/**
 * Returns true if `latest` is a newer semver than `current`.
 * Simplified variant extracted from version-check.ts.
 */
const isNewerVersion = (current: string, latest: string): boolean => {
	const c = current.replace(/^v/, "").split(".");
	const l = latest.replace(/^v/, "").split(".");
	for (let i = 0; i < 3; i++) {
		const cv = parseInt(c[i] ?? "0", 10);
		const lv = parseInt(l[i] ?? "0", 10);
		if (lv > cv) return true;
		if (lv < cv) return false;
	}
	return false;
};

// ─── Layer ──────────────────────────────────────────────────────────────────

export const VersionCheckerLive = (config: VersionCheckerConfig) =>
	Layer.scoped(
		VersionCheckerTag,
		Effect.gen(function* () {
			const latestKnown = yield* Ref.make<string | null>(null);

			const check = Effect.gen(function* () {
				const latest = yield* config.fetchLatestVersion();
				if (latest) {
					const prev = yield* Ref.get(latestKnown);
					const current = config.getCurrentVersion();
					if (latest !== prev && isNewerVersion(current, latest)) {
						yield* Ref.set(latestKnown, latest);
						yield* config.broadcast({
							type: "version_update",
							current,
							latest,
						});
					}
				}
			});

			// Background fiber — retries on unexpected errors
			yield* check.pipe(
				Effect.repeat(Schedule.spaced(config.checkInterval)),
				Effect.retry(
					Schedule.exponential("10 seconds").pipe(
						Schedule.intersect(Schedule.recurs(3)),
					),
				),
				Effect.catchAll((e) =>
					Effect.logWarning("Version checker failed after retries", e),
				),
				Effect.forkScoped,
			);

			return {
				getLatestKnown: () => Ref.get(latestKnown),
				getCurrentVersion: () => Effect.succeed(config.getCurrentVersion()),
			};
		}),
	);

// Re-export isNewerVersion for testing
export { isNewerVersion };
