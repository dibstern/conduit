// ─── Relay Factory Layer ────────────────────────────────────────────────────
// Effect-native factory for creating ProjectRelay instances.
//
// RelayFactoryTag — service that creates relays given a StoredProject + URL.
// HttpServerRefTag — Ref<http.Server | null> shared between relay factory
//                    and daemon server lifecycle. The server isn't available
//                    until after Layer construction, so the Ref starts null.
//
// RelayFactoryLive captures deps from Effect Context and delegates to the
// imperative createProjectRelay. The full conversion of createProjectRelay
// to Effect is beyond scope — this provides the Effect-native entry point.

import { mkdirSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { Context, Data, Effect, Layer, Ref } from "effect";
import type { ProjectRelay } from "../../../relay/relay-stack.js";
import type { StoredProject } from "../../../types.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";

// ─── Error types ────────────────────────────────────────────────────────────

export class RelayFactoryError extends Data.TaggedError("RelayFactoryError")<{
	reason: string;
	cause?: unknown;
}> {
	get message(): string {
		const inner = this.cause instanceof Error ? `: ${this.cause.message}` : "";
		return `${this.reason}${inner}`;
	}
}

// ─── HttpServerRefTag ───────────────────────────────────────────────────────

/**
 * Ref holding the HTTP server instance. Starts as null because the server
 * is created during Layer construction (by makeHttpServerLive) and isn't
 * available until the server layer has built. Both the relay factory and
 * daemon-main read from this Ref.
 */
export class HttpServerRefTag extends Context.Tag("HttpServerRef")<
	HttpServerRefTag,
	Ref.Ref<http.Server | null>
>() {}

/**
 * Layer that creates an HttpServerRef initialized to null.
 * The server lifecycle layer sets the Ref once the server is listening.
 */
export const HttpServerRefLive: Layer.Layer<HttpServerRefTag> = Layer.effect(
	HttpServerRefTag,
	Ref.make<http.Server | null>(null),
);

// ─── RelayFactory interface ─────────────────────────────────────────────────

/**
 * Factory service for creating ProjectRelay instances from Effect Context.
 *
 * The `create` method returns an Effect that:
 * 1. Opens a SQLite persistence DB for the project
 * 2. Calls createProjectRelay with dependencies from Context
 * 3. Lets RelayCache own the long-lived relay finalizer
 */
export interface RelayFactory {
	readonly create: (
		project: StoredProject,
		opencodeUrl: string,
	) => Effect.Effect<ProjectRelay, RelayFactoryError>;
}

// ─── RelayFactoryTag ────────────────────────────────────────────────────────

export class RelayFactoryTag extends Context.Tag("RelayFactory")<
	RelayFactoryTag,
	RelayFactory
>() {}

// ─── RelayFactoryLive ───────────────────────────────────────────────────────

/**
 * Create a Layer providing RelayFactoryTag.
 *
 * Dependencies (from Effect Context):
 * - DaemonConfigRefTag — for reading runtime config
 * - HttpServerRefTag — for the HTTP server reference
 *
 * HttpServerRefLive is self-provided (starts as null Ref).
 * DaemonConfigRefTag must be provided by the caller (daemon-layers composition).
 *
 * The factory's `create` method is called at runtime (not build time)
 * when a relay needs to be created for a specific project.
 *
 * @param configDir - The daemon config directory path (e.g., ~/.conduit)
 */
export const RelayFactoryLive = (
	configDir: string,
): Layer.Layer<RelayFactoryTag | HttpServerRefTag, never, DaemonConfigRefTag> =>
	Layer.effect(
		RelayFactoryTag,
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const httpServerRef = yield* HttpServerRefTag;

			return {
				create: (
					project: StoredProject,
					opencodeUrl: string,
				): Effect.Effect<ProjectRelay, RelayFactoryError> =>
					Effect.gen(function* () {
						// Read current HTTP server from Ref
						const httpServer = yield* Ref.get(httpServerRef);
						if (!httpServer) {
							return yield* new RelayFactoryError({
								reason: "HTTP server not started",
							});
						}

						// Create persistence DB directory and open SQLite
						const conduitDir = resolve(project.directory, ".conduit");
						yield* Effect.try({
							try: () => mkdirSync(conduitDir, { recursive: true }),
							catch: (cause) =>
								new RelayFactoryError({
									reason: `Failed to create .conduit directory at ${conduitDir}`,
									cause,
								}),
						});

						const dbPath = resolve(conduitDir, "events.db");

						// Dynamic import to avoid circular dependency at module load time
						const { createProjectRelay } = yield* Effect.tryPromise({
							try: () => import("../../../relay/relay-stack.js"),
							catch: (cause) =>
								new RelayFactoryError({
									reason: "Failed to import relay-stack module",
									cause,
								}),
						});

						// Read config for any runtime values needed
						const _config = yield* Ref.get(configRef);

						// Create the relay using the imperative createProjectRelay.
						// Callbacks are stubbed — the full wiring of callbacks to
						// Effect services happens when consumers are converted (Task 11+).
						const relay = yield* Effect.tryPromise({
							try: () => {
								const ac = new AbortController();
								return createProjectRelay({
									httpServer,
									opencodeUrl,
									projectDir: project.directory,
									slug: project.slug,
									noServer: true,
									signal: ac.signal,
									configDir,
									persistenceDbPath: dbPath,
								});
							},
							catch: (cause) =>
								new RelayFactoryError({
									reason: `Failed to create relay for project "${project.slug}"`,
									cause,
								}),
						});

						return relay;
					}).pipe(
						Effect.annotateLogs("slug", project.slug),
						Effect.withSpan("RelayFactory.create", {
							attributes: {
								slug: project.slug,
								directory: project.directory,
							},
						}),
					),
			} satisfies RelayFactory;
		}),
	).pipe(
		// Merge HttpServerRefLive so HttpServerRefTag is both provided to
		// the factory AND exposed to the caller (for setting the server later).
		Layer.provideMerge(HttpServerRefLive),
	);
