import { Context, type Duration, Effect, Layer, Ref, Schedule } from "effect";

export interface PortScannerConfig {
	probeFn: (port: number) => Effect.Effect<boolean>;
	portRange: [number, number];
	scanInterval: Duration.Input;
	removalThreshold: number; // Consecutive failures before removal
	onDiscovered: (port: number) => Effect.Effect<void>;
	onLost: (port: number) => Effect.Effect<void>;
	excludedPorts?: Set<number>;
	getExcludedPorts?: () => Effect.Effect<ReadonlySet<number>>;
	onScan?: (result: PortScanResult) => Effect.Effect<void>;
}

export interface PortScanResult {
	readonly discovered: number[];
	readonly lost: number[];
	readonly active: number[];
}

interface PortScannerService {
	getKnownPorts: () => Effect.Effect<Set<number>>;
	scanNow: () => Effect.Effect<PortScanResult>;
}

export class PortScannerTag extends Context.Service<
	PortScannerTag,
	PortScannerService
>()("PortScanner") {}

interface ScanState {
	knownPorts: Set<number>;
	failureCounts: Map<number, number>;
}

export const PortScannerLive = (config: PortScannerConfig) =>
	Layer.effect(
		PortScannerTag,
		Effect.gen(function* () {
			const state = yield* Ref.make<ScanState>({
				knownPorts: new Set(),
				failureCounts: new Map(),
			});

			const runScan: Effect.Effect<PortScanResult> = Effect.gen(function* () {
				const [start, end] = config.portRange;
				const excluded = new Set(config.excludedPorts ?? []);
				if (config.getExcludedPorts != null) {
					const dynamicExcluded = yield* config.getExcludedPorts();
					for (const port of dynamicExcluded) excluded.add(port);
				}
				const ports = Array.from(
					{ length: end - start + 1 },
					(_, i) => start + i,
				).filter((p) => !excluded.has(p));

				const results = yield* Effect.forEach(
					ports,
					(port) =>
						config.probeFn(port).pipe(
							Effect.map((alive) => ({ port, alive })),
							Effect.catch(() => Effect.succeed({ port, alive: false })),
						),
					{ concurrency: 10 },
				);

				const current = yield* Ref.get(state);
				const newKnown = new Set(current.knownPorts);
				const newFailures = new Map(current.failureCounts);
				const discovered: number[] = [];
				const lost: number[] = [];
				const active: number[] = [];

				for (const { port, alive } of results) {
					if (alive) {
						active.push(port);
						newFailures.delete(port);
						if (!current.knownPorts.has(port)) {
							discovered.push(port);
							newKnown.add(port);
							yield* config
								.onDiscovered(port)
								.pipe(
									Effect.catch((e) =>
										Effect.logWarning("onDiscovered error", e),
									),
								);
						}
					} else if (current.knownPorts.has(port)) {
						const failures = (newFailures.get(port) ?? 0) + 1;
						if (failures >= config.removalThreshold) {
							lost.push(port);
							newKnown.delete(port);
							newFailures.delete(port);
							yield* config
								.onLost(port)
								.pipe(
									Effect.catch((e) => Effect.logWarning("onLost error", e)),
								);
						} else {
							newFailures.set(port, failures);
						}
					}
				}

				yield* Ref.set(state, {
					knownPorts: newKnown,
					failureCounts: newFailures,
				});

				const result: PortScanResult = { discovered, lost, active };
				if (config.onScan != null) {
					yield* config
						.onScan(result)
						.pipe(Effect.catch((e) => Effect.logWarning("onScan error", e)));
				}
				return result;
			});

			// Background fiber — retries on unexpected errors
			yield* runScan.pipe(
				Effect.repeat(Schedule.spaced(config.scanInterval)),
				Effect.retry(
					Schedule.max([Schedule.exponential("5 seconds"), Schedule.recurs(3)]),
				),
				Effect.catch((e) =>
					Effect.logWarning("Port scanner failed after retries", e),
				),
				Effect.forkScoped,
			);

			return {
				getKnownPorts: () =>
					Ref.get(state).pipe(Effect.map((s) => new Set(s.knownPorts))),
				scanNow: () => runScan,
			};
		}),
	);
