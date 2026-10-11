// Each keep-awake child owns a scope attached to the daemon's layer scope.

import { Command, CommandExecutor } from "@effect/platform";
import {
	Context,
	Effect,
	Either,
	ExecutionStrategy,
	Exit,
	Layer,
	Option,
	Ref,
	Scope,
	Stream,
} from "effect";
import {
	type KeepAwakeOptions,
	resolveKeepAwakeCommand,
} from "../../../daemon/keep-awake.js";

interface KeepAwakeService {
	activate: () => Effect.Effect<void>;
	deactivate: () => Effect.Effect<void>;
	setCommand: (command: string, args: readonly string[]) => Effect.Effect<void>;
	getCommand: () => Effect.Effect<string | null>;
	isActive: () => Effect.Effect<boolean>;
	isSupported: () => Effect.Effect<boolean>;
}

export class KeepAwakeTag extends Context.Tag("KeepAwake")<
	KeepAwakeTag,
	KeepAwakeService
>() {}

export const KeepAwakeLive = (
	config?: KeepAwakeOptions & { enabled?: boolean },
) =>
	Layer.scoped(
		KeepAwakeTag,
		Effect.gen(function* () {
			const executor = yield* CommandExecutor.CommandExecutor;
			const scope = yield* Effect.scope;
			const lock = yield* Effect.makeSemaphore(1);
			const enabled = yield* Ref.make(false);
			const resolved = yield* Ref.make(
				Option.fromNullable(resolveKeepAwakeCommand(config)),
			);
			const current = yield* Ref.make<
				Option.Option<{
					scope: Scope.CloseableScope;
					process: CommandExecutor.Process;
				}>
			>(Option.none());

			const isActive = Ref.get(current).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeed(false),
						onSome: (child) => child.process.isRunning,
					}),
				),
				Effect.catchAll(() => Effect.succeed(false)),
			);
			const stop = Effect.gen(function* () {
				const child = yield* Ref.getAndSet(current, Option.none());
				if (Option.isSome(child))
					yield* Scope.close(child.value.scope, Exit.void);
			});
			const start = Effect.gen(function* () {
				const command = yield* Ref.get(resolved);
				if (Option.isNone(command)) {
					yield* Effect.logWarning("No keep-awake command available");
					return;
				}
				const { command: executable, args } = command.value;
				const commandLine = [executable, ...args].join(" ");
				const childScope = yield* Scope.fork(
					scope,
					ExecutionStrategy.sequential,
				);
				const result = yield* executor
					.start(
						Command.make(executable, ...args).pipe(
							Command.stdin(Stream.empty),
							Command.stdout("inherit"),
							Command.stderr("inherit"),
						),
					)
					.pipe(Scope.extend(childScope), Effect.either);
				if (Either.isLeft(result)) {
					yield* Scope.close(childScope, Exit.void);
					yield* Effect.logWarning(
						`Could not start keep-awake command: ${commandLine}`,
						result.left,
					);
					return;
				}
				const child = result.right;
				// Kill the group even if its leader exited or ignores SIGTERM.
				// This finalizer runs before the executor's own release waits for exit.
				yield* Scope.addFinalizer(
					childScope,
					child.kill("SIGKILL").pipe(Effect.ignore),
				);
				yield* Ref.set(
					current,
					Option.some({ scope: childScope, process: child }),
				);
				// Observe from the layer scope so cleanup can close the child scope
				// without trying to interrupt the observer itself.
				yield* child.exitCode.pipe(
					Effect.exit,
					Effect.flatMap((exit) => {
						if (Exit.isInterrupted(exit)) return Effect.void;
						return lock.withPermits(1)(
							Effect.gen(function* () {
								const active = yield* Ref.get(current);
								// Intentional stop/replacement cleared this child before killing it.
								if (Option.isNone(active) || active.value.process !== child)
									return;
								if (Exit.isSuccess(exit)) {
									yield* Effect.logWarning(
										`Keep-awake command exited unexpectedly: ${commandLine} (exit ${exit.value})`,
									);
								} else {
									yield* Effect.logWarning(
										`Keep-awake command exited unexpectedly: ${commandLine}`,
										exit.cause,
									);
								}
								yield* stop;
							}).pipe(Effect.uninterruptible),
						);
					}),
					Effect.interruptible,
					Effect.forkIn(scope),
				);
			});

			// Finish resource acquisition/registration even if an RPC is interrupted.
			const activate = lock.withPermits(1)(
				Effect.gen(function* () {
					yield* Ref.set(enabled, true);
					if (yield* isActive) return;
					yield* stop;
					yield* start;
				}).pipe(Effect.uninterruptible),
			);
			const deactivate = lock.withPermits(1)(
				Effect.gen(function* () {
					yield* Ref.set(enabled, false);
					yield* stop;
				}).pipe(Effect.uninterruptible),
			);

			yield* Effect.addFinalizer(() => deactivate);
			if (config?.enabled) yield* activate;

			return {
				activate: () => activate,
				deactivate: () => deactivate,
				setCommand: (command, args) =>
					lock.withPermits(1)(
						Effect.gen(function* () {
							yield* Ref.set(
								resolved,
								Option.fromNullable(
									resolveKeepAwakeCommand({ command, args: [...args] }),
								),
							);
							yield* stop;
							if (yield* Ref.get(enabled)) yield* start;
						}).pipe(Effect.uninterruptible),
					),
				getCommand: () =>
					Ref.get(resolved).pipe(
						Effect.map(
							Option.match({
								onNone: () => null,
								// Quote parts with spaces so the browser can split the
								// string back into the same argv.
								onSome: ({ command, args }) =>
									[command, ...args]
										.map((part) => (/\s/.test(part) ? `'${part}'` : part))
										.join(" "),
							}),
						),
					),
				isActive: () => isActive,
				isSupported: () => Ref.get(resolved).pipe(Effect.map(Option.isSome)),
			} satisfies KeepAwakeService;
		}),
	);
