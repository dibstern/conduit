import { rename, writeFile } from "node:fs/promises";
import {
	createHistogram,
	monitorEventLoopDelay,
	performance,
} from "node:perf_hooks";
import { Cause, Effect } from "effect";

function isSqliteBusy(error: unknown, seen = new Set<object>()): boolean {
	if (typeof error === "string")
		return /\bSQLITE_BUSY(?:_SNAPSHOT)?\b/.test(error);
	if (typeof error !== "object" || error === null || seen.has(error))
		return false;
	seen.add(error);
	return (
		("code" in error &&
			(error.code === "SQLITE_BUSY" ||
				error.code === "SQLITE_BUSY_SNAPSHOT")) ||
		("cause" in error && isSqliteBusy(error.cause, seen))
	);
}

function makeContentionMetrics(file: string) {
	const eventLoop = monitorEventLoopDelay({ resolution: 10 });
	const permitWait = createHistogram();
	let sqliteBusy = 0;
	let pending = Promise.resolve();
	let closed = false;
	const temp = `${file}.${process.pid}.tmp`;
	const ms = (ns: number) => Math.round(ns / 100_000) / 10;
	const flush = () => {
		const snapshot = {
			eventLoopDelayMs: {
				min: eventLoop.count ? ms(eventLoop.min) : 0,
				mean: eventLoop.count ? ms(eventLoop.mean) : 0,
				p50: eventLoop.count ? ms(eventLoop.percentile(50)) : 0,
				p99: eventLoop.count ? ms(eventLoop.percentile(99)) : 0,
				max: eventLoop.count ? ms(eventLoop.max) : 0,
			},
			commitPermitWaitMs: {
				count: permitWait.count,
				p50: permitWait.count ? ms(permitWait.percentile(50)) : 0,
				p99: permitWait.count ? ms(permitWait.percentile(99)) : 0,
				max: permitWait.count ? ms(permitWait.max) : 0,
			},
			sqliteBusy,
		};
		// Serialize writes so a periodic flush cannot replace the final snapshot.
		pending = pending
			.then(() => writeFile(temp, `${JSON.stringify(snapshot)}\n`))
			.then(() => rename(temp, file))
			.catch((error: unknown) => {
				console.error("[daemon] Contention metrics write failed:", error);
			});
		return pending;
	};
	eventLoop.enable();
	const timer = setInterval(flush, 1_000);
	timer.unref();
	const metrics = {
		withCommitPermit<A, E, R>(
			withPermit: <A, E, R>(
				effect: Effect.Effect<A, E, R>,
			) => Effect.Effect<A, E, R>,
			effect: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E, R> {
			return Effect.suspend(() => {
				const requested = performance.now();
				return withPermit(
					Effect.sync(() => {
						permitWait.record(
							Math.max(1, Math.round((performance.now() - requested) * 1e6)),
						);
					}).pipe(Effect.andThen(effect)),
				).pipe(
					Effect.tapErrorCause((cause) =>
						Effect.sync(() => {
							if (
								[...Cause.failures(cause), ...Cause.defects(cause)].some(
									(error) => isSqliteBusy(error),
								)
							)
								sqliteBusy += 1;
						}),
					),
				);
			});
		},
		async close() {
			if (closed) return pending;
			closed = true;
			clearInterval(timer);
			eventLoop.disable();
			await flush();
			if (contentionMetrics === metrics) contentionMetrics = undefined;
		},
	};
	return metrics;
}

export let contentionMetrics:
	| ReturnType<typeof makeContentionMetrics>
	| undefined;

export function startContentionMetrics() {
	const file = process.env["CONDUIT_CONTENTION_METRICS"];
	if (!file) return undefined;
	contentionMetrics = makeContentionMetrics(file);
	return contentionMetrics;
}
