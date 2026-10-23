import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
	type Cause,
	Duration,
	Effect,
	Exit,
	Fiber,
	Option,
	Queue,
	Schema,
	Stream,
	type Take,
} from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { advanceTouchesScope } from "../../../contracts/read-model-advance.js";
import {
	type ResumeBase,
	ResumePoint,
	type ShellEnvelope,
	type ShellProjectsFrame,
} from "../../../contracts/ws-rpc.js";
import * as Failure from "../../../effect/failure-classification.js";
import {
	makeReadQueryEffect,
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type { SessionInfo } from "../../../shared-types.js";
import { stream } from "../../relay/Services/read-model-subscription.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import type { AccountDirectory } from "./account-directory.js";
import type { SessionActivityTag } from "./session-activity.js";
import { makeSessionRows } from "./session-rows.js";

export type ShellSubscriptionError = ReadQueryEffectError | SqlError;

/** What one sidebar read cost the server, for load tests. */
export interface SidebarRead {
	readonly ms: number;
	readonly rows: number;
}

const sidebarReads = channel("conduit:sidebar-read");

const ResumePointBody = Schema.StringFromBase64Url.pipe(
	Schema.decodeTo(
		Schema.fromJsonString(
			Schema.Struct({
				store: Schema.String,
				membership: Schema.String,
				sequence: Schema.Number,
			}),
		),
	),
);

type ShellResume = {
	readonly resumeFromSequence?: number | undefined;
	readonly resumeBase?: ResumeBase | undefined;
	readonly resumePoint?: ResumePoint | undefined;
};

// Folders are part of membership: session rows derive Git and workspace fields
// from them, so a folder edit needs a fresh snapshot and a new resume point.
const fingerprint = ({ projects }: ShellProjectsFrame) =>
	createHash("sha256")
		.update(
			JSON.stringify(
				projects
					.map(({ slug, unavailableReason, folders }) => [
						slug,
						unavailableReason !== undefined,
						folders,
					])
					.sort(([left], [right]) => String(left).localeCompare(String(right))),
			),
		)
		.digest("hex");

/** Share one counter and one scoped sidebar read across all registered projects. */
export const subscribeShellProjects = <E>(
	options: ShellResume,
	projects: Stream.Stream<ShellProjectsFrame, E>,
	{ standalone = false }: { readonly standalone?: boolean } = {},
): Stream.Stream<
	ShellEnvelope,
	ShellSubscriptionError | E,
	| ReadQueryEffectTag
	| SessionEventBusTag
	| SessionActivityTag
	| AccountDirectory
	| SqlClient.SqlClient
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const bus = yield* SessionEventBusTag;
			const readQuery = yield* ReadQueryEffectTag;
			const store = yield* readQuery.readStoreIdentity();
			const output =
				yield* Queue.bounded<
					Take.Take<ShellEnvelope, ShellSubscriptionError | E>
				>(16);
			yield* Effect.addFinalizer(() => Queue.shutdown(output));
			let current: ShellProjectsFrame | undefined;
			let membership: string | undefined;
			let live: Fiber.Fiber<void, never> | undefined;
			let projectsDone = false;
			let rowsDone = false;
			const finish = Effect.suspend(() =>
				projectsDone && rowsDone
					? Queue.offer(output, Exit.void).pipe(Effect.asVoid)
					: Effect.void,
			);
			const fail = (cause: Cause.Cause<ShellSubscriptionError | E>) =>
				Failure.isInterruptedOnly(cause)
					? Effect.void
					: Queue.offer(output, Exit.failCause(cause)).pipe(Effect.asVoid);

			yield* projects.pipe(
				Stream.runForEach((frame) =>
					Effect.gen(function* () {
						const nextMembership = fingerprint(frame);
						const changed = nextMembership !== membership;
						// Stop the old source before the new projects frame, so no old
						// row can arrive between that frame and its replacement snapshot.
						if (changed && live !== undefined) yield* Fiber.interrupt(live);
						current = frame;
						yield* Queue.offer(output, [frame]);
						if (!changed) return;
						const first = membership === undefined;
						membership = nextMembership;
						rowsDone = false;
						const healthy = () =>
							(current?.projects ?? [])
								.filter((project) => project.unavailableReason === undefined)
								.map((project) => ({
									slug: project.slug,
									folders: project.folders,
								}));
						const scopes = healthy();
						const [head, ...tail] = scopes;
						const scope = head && {
							projectIds: [head.slug, ...tail.map(({ slug }) => slug)] as const,
						};
						const rows = yield* makeSessionRows(
							standalone && head !== undefined ? head : { projects: healthy },
						);
						const point = Option.getOrUndefined(
							Option.filter(
								Option.fromNullishOr(
									first ? options.resumePoint : undefined,
								).pipe(Option.flatMap(Schema.decodeOption(ResumePointBody))),
								(body) =>
									body.store === store && body.membership === nextMembership,
							),
						);
						const resume = !first
							? {}
							: options.resumePoint === undefined && standalone
								? options
								: point === undefined
									? {}
									: {
											resumeFromSequence: options.resumeFromSequence,
											resumeBase: { sequence: point.sequence },
										};
						live = yield* stream<SessionInfo, ShellSubscriptionError>({
							bus,
							source: {
								name: "shell",
								collections: ["sidebar"],
								shareReads: true,
								shareKey: `shell/${store}/${nextMembership}`,
								read: (range, base) =>
									rows
										.read({
											...range,
											...(base === undefined ? {} : { listing: true }),
										})
										.pipe(
											Effect.timed,
											Effect.map(([elapsed, list]) => {
												if (sidebarReads.hasSubscribers)
													sidebarReads.publish({
														ms: Duration.toMillis(elapsed),
														rows: list.rows.length,
													} satisfies SidebarRead);
												return list;
											}),
										),
								route: (advance) => ({
									moved:
										scope !== undefined && advanceTouchesScope(advance, scope),
									removed: [],
								}),
								resume: "catchUp",
							},
							...(resume.resumeFromSequence === undefined
								? {}
								: { resumeFromSequence: resume.resumeFromSequence }),
							...(resume.resumeBase === undefined
								? {}
								: { resumeBase: resume.resumeBase }),
						}).pipe(
							Stream.map(
								(envelope): ShellEnvelope =>
									envelope._tag === "snapshot" && store !== undefined
										? {
												...envelope,
												resumePoint: ResumePoint.make(
													Schema.encodeSync(ResumePointBody)({
														store,
														membership: nextMembership,
														sequence: envelope.sequence,
													}),
												),
											}
										: envelope,
							),
							Stream.runForEach((envelope) => Queue.offer(output, [envelope])),
							Effect.tap(() => {
								rowsDone = true;
								return finish;
							}),
							Effect.catchCause(fail),
							Effect.forkScoped,
						);
					}),
				),
				Effect.tap(() => {
					projectsDone = true;
					return finish;
				}),
				Effect.catchCause(fail),
				Effect.forkScoped,
			);
			return Stream.fromQueue(output).pipe(Stream.flattenTake);
		}),
	);

/** The daemon provides the shared store directly; serving this never acquires a relay. */
export const subscribeDaemonShell = <E>(
	options: ShellResume,
	projects: Stream.Stream<ShellProjectsFrame, E>,
) =>
	Stream.unwrap(
		makeReadQueryEffect.pipe(
			Effect.map((readQuery) =>
				subscribeShellProjects(options, projects).pipe(
					Stream.provideService(ReadQueryEffectTag, readQuery),
				),
			),
		),
	);
