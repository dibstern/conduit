import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Queue,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { SSEEvent } from "../../../relay/opencode-events.js";
import { extractSessionId } from "../../../relay/sse-wiring.js";
import { audienceOf, delivers } from "../../../server/event-audiences.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
} from "./opencode-instances-service.js";
import { OpenCodeSessionIds } from "./opencode-session-ids.js";
import { OwnerScopes } from "./owner-scopes.js";

/** Events a project heard while no pipeline was attached; the oldest go first. */
const BUFFER_LIMIT = 1_000;

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | undefined =>
	typeof value === "object" && value !== null ? (value as Fields) : undefined;

/**
 * The event's properties with every session id it names renamed: top-level and
 * part `sessionID`, a message's `info.sessionID`, a session's `info.id` and
 * `info.parentID`. Ids `rename` leaves alone keep their place.
 */
const renameSessionIds = (
	properties: Fields,
	rename: (id: string) => string,
): Fields => {
	const renamed = (value: Fields, keys: readonly string[]) => {
		const ids = keys.flatMap((key) => {
			const id = value[key];
			return typeof id === "string" ? [[key, rename(id)] as const] : [];
		});
		return { ...value, ...Object.fromEntries(ids) };
	};
	const part = fields(properties["part"]);
	const info = fields(properties["info"]);
	return {
		...renamed(properties, ["sessionID"]),
		...(part ? { part: renamed(part, ["sessionID"]) } : {}),
		...(info
			? {
					info: renamed(
						info,
						"sessionID" in info ? ["sessionID"] : ["id", "parentID"],
					),
				}
			: {}),
	};
};

/**
 * One OpenCode event subscription per registered project, held for the
 * daemon's life rather than a tab's (82tn.16, S3). Each event goes to the
 * project that owns its session, so a shared folder never feeds a session
 * to a second project and a removed project's sessions reach no one.
 */
export class OpenCodeProjectStreams extends Context.Service<
	OpenCodeProjectStreams,
	{
		/** Feed the project's pipeline; held events arrive first. Returns the detach. */
		readonly attach: (
			slug: string,
			send: (message: OpenCodeInstanceEvent) => void,
		) => Effect.Effect<Effect.Effect<void>>;
		/** Register before dispatch; earlier directories stay live for in-flight turns. */
		readonly includeDirectory: (
			slug: string,
			directory: string,
		) => Effect.Effect<void>;
		/** Projects holding events with no pipeline attached. */
		readonly wakes: Queue.Dequeue<string>;
	}
>()("OpenCodeProjectStreams") {}

export const makeOpenCodeProjectStreamsLive = (
	projects: () => ReadonlyArray<{
		readonly slug: string;
		readonly folders: readonly string[];
	}>,
) =>
	Layer.effect(
		OpenCodeProjectStreams,
		Effect.gen(function* () {
			const instances = yield* OpenCodeInstancesTag;
			const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
			const scope = yield* Effect.scope;
			const owners = yield* Effect.serviceOption(OwnerScopes);
			const sessionIds = yield* Effect.serviceOption(OpenCodeSessionIds);
			const gate = yield* Semaphore.make(1);
			const wakes = yield* Queue.sliding<string>(64);
			type Entry = {
				readonly included: Set<string>;
				folders: readonly string[];
				send: ((message: OpenCodeInstanceEvent) => void) | undefined;
				held: OpenCodeInstanceEvent[];
				waking: boolean;
				fiber: Fiber.Fiber<void> | undefined;
			};
			const entries = new Map<string, Entry>();
			const foldersOf = (slug: string) =>
				projects().find((project) => project.slug === slug)?.folders;

			const workspaceDirectories = (slug: string) =>
				Effect.gen(function* () {
					if (sql._tag === "None") return [];
					const rows = yield* sql.value<{ workspace: string }>`
						SELECT workspace FROM sessions
						WHERE project_id = ${slug} AND workspace IS NOT NULL`.pipe(
						Effect.orElseSucceed(() => []),
					);
					const directories: string[] = [];
					for (const row of rows) {
						const workspace = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(SessionWorkspaceSchema),
						)(row.workspace).pipe(Effect.option);
						if (workspace._tag === "Some")
							directories.push(
								...Object.values(workspace.value.worktrees ?? {}),
							);
					}
					return directories;
				});

			const ownerOf = (sessionId: string) =>
				sql._tag === "None"
					? Effect.succeed(undefined)
					: sql.value<{ project_id: string | null }>`
							SELECT project_id FROM sessions WHERE id = ${sessionId}`.pipe(
							Effect.map((rows) => rows[0]?.project_id ?? undefined),
							Effect.orElseSucceed(() => undefined),
						);

			// OpenCode names its own sessions; Conduit's pipeline sees only Conduit's (82tn.80).
			const toConduitIds = (
				message: Extract<OpenCodeInstanceEvent, { _tag: "event" }>,
			) =>
				Effect.gen(function* () {
					const payload = fields(message.payload);
					const properties = fields(payload?.["properties"]);
					if (sessionIds._tag === "None" || !payload || !properties)
						return message;
					const natives = new Set<string>();
					renameSessionIds(properties, (id) => {
						natives.add(id);
						return id;
					});
					const conduit = new Map<string, string>();
					for (const id of natives) {
						const mapped = yield* sessionIds.value.conduit(
							message.instanceId,
							id,
						);
						if (mapped !== id) conduit.set(id, mapped);
					}
					if (conduit.size === 0) return message;
					return {
						...message,
						payload: {
							...payload,
							properties: renameSessionIds(
								properties,
								(id) => conduit.get(id) ?? id,
							),
						},
					};
				});

			const deliver = (
				slug: string,
				entry: Entry,
				message: OpenCodeInstanceEvent,
			) => {
				if (entry.send) return entry.send(message);
				if (message._tag === "heartbeat") return;
				entry.held.push(message);
				if (entry.held.length > BUFFER_LIMIT) entry.held.shift();
				if (message._tag === "event" && !entry.waking) {
					entry.waking = true;
					Queue.offerUnsafe(wakes, slug);
				}
			};

			const route = (
				slug: string,
				entry: Entry,
				received: OpenCodeInstanceEvent,
			) =>
				Effect.gen(function* () {
					if (!foldersOf(slug)) {
						if (entries.get(slug) === entry) entries.delete(slug);
						return yield* Effect.interrupt;
					}
					if (received._tag !== "event") return deliver(slug, entry, received);
					const message = yield* toConduitIds(received);
					const payload = message.payload as Partial<SSEEvent> | null;
					const sessionId = payload?.properties
						? extractSessionId(payload as SSEEvent)
						: undefined;
					const owner = sessionId ? yield* ownerOf(sessionId) : undefined;
					// A session no project owns yet belongs to the project whose folder heard it.
					const audience = audienceOf(
						{ type: "opencode", sessionId, projectId: slug },
						() => owner ?? slug,
					);
					if (
						delivers(audience, {
							projects: new Set([slug]),
							sessions: new Set(sessionId ? [sessionId] : []),
							ptys: new Map(),
						})
					)
						deliver(slug, entry, message);
				});

			const drop = (slug: string, entry: Entry) =>
				Effect.gen(function* () {
					if (entries.get(slug) === entry) entries.delete(slug);
					if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
				});

			const subscribe = (slug: string) =>
				Effect.gen(function* () {
					const entry: Entry = {
						included: new Set(yield* workspaceDirectories(slug)),
						folders: foldersOf(slug) ?? [],
						send: undefined,
						held: [],
						waking: false,
						fiber: undefined,
					};
					entries.set(slug, entry);
					const ready = yield* Deferred.make<void>();
					entry.fiber = yield* Effect.forkIn(
						Effect.scoped(
							Effect.gen(function* () {
								// Registered before attach returns, so no event slips between.
								const pull = yield* Stream.toPull(
									// Keeps the last folders after removal, so unsubscribing forgets them.
									instances.events(() => {
										entry.folders = foldersOf(slug) ?? entry.folders;
										return [...entry.folders, ...entry.included];
									}),
								);
								yield* Deferred.succeed(ready, undefined);
								yield* Stream.runForEach(
									Stream.fromPull(Effect.succeed(pull)),
									(message) => route(slug, entry, message),
								);
							}),
						),
						scope,
					);
					yield* Deferred.await(ready);
					// Removing the project closes its owner scope, which ends the subscription.
					if (owners._tag === "Some")
						yield* owners.value.projectScope(slug).pipe(
							Effect.flatMap((owner) =>
								owner.acquire<void, never, never>(
									Effect.addFinalizer(() => drop(slug, entry)),
								),
							),
							Effect.catch(() => drop(slug, entry)),
						);
					return entry;
				});

			/** Subscribe registered projects, drop removed ones. */
			const sync = gate.withPermits(1)(
				Effect.gen(function* () {
					const registered = new Set(projects().map(({ slug }) => slug));
					for (const [slug, entry] of entries)
						if (!registered.has(slug)) yield* drop(slug, entry);
					for (const slug of registered)
						if (!entries.has(slug)) yield* subscribe(slug);
				}),
			);
			yield* sync;

			return {
				wakes,
				includeDirectory: (slug, directory) =>
					Effect.sync(() => {
						entries.get(slug)?.included.add(directory);
					}),
				attach: (slug, send) =>
					Effect.gen(function* () {
						yield* sync;
						const entry = entries.get(slug);
						if (!entry) return Effect.void;
						const held = entry.held;
						entry.held = [];
						entry.waking = false;
						entry.send = send;
						for (const message of held) send(message);
						return Effect.sync(() => {
							if (entry.send === send) entry.send = undefined;
						});
					}),
			};
		}),
	);
