/*
 * 82tn.16 (S5, slice 4): each project's ingestion side (pending interactions,
 * alert ledger, provider runtime ingestion, OpenCode ingress, translator) is
 * built once per project in its owner scope, not by each relay. Failure modes
 * (audit.md rows 79-87), written before the code:
 * 79/80 a project no relay has opened, or added while running, has no
 *    ingestion to land a provider event in;
 * 82 after a restart a cold project keeps the last process's OpenCode history
 *    proof, because only a relay start cleared it;
 * 83 two projects sharing a folder share a translator's sessionless parts or
 *    write each other's rows;
 * 86 a relay replaced while registered forgets a pending permission;
 * 87 a viewed session's turn end raises a cross-session alert, because the
 *    check read the relay's own client list.
 * Rows 81 (removal), 84 (reconnect) and 85 (store isolation) are covered by
 * project-services.test.ts, daemon-session-manager.test.ts and row 83 here.
 *
 * Slice 5 (rows 88-97): project settings and session titles are built once
 * per project too:
 * 88/89 a project no relay has opened, or added while running, has none;
 * 90 a relay replaced while registered drops a title in flight and the
 *    discovered model catalogs with the old relay;
 * 91 two projects sharing a folder share settings or titles.
 * Rows 92-95 are covered by project-services.test.ts (removal, reconnect) and
 * row 91 here (store isolation). The turn service and inbox stay with the
 * relay: they hold the project's folders from when they were built.
 *
 * Slice 7 (rows 99-101): tool details, directory listing and agent liveness
 * are built once per project:
 * 99 a project no relay has opened, or added while running, has none;
 * 100 a relay replaced while registered builds its own;
 * 101 two projects sharing a folder share one tool-details reader.
 * Store isolation is row 76 (the reader reads the project's bound store).
 *
 * Lane 16o (rows 103-107): the turn service and inbox are built once per
 * project, and each turn reads the project's folders when it runs:
 * 103 a project no relay has opened, or added while running, has neither;
 * 104 a relay replaced while registered builds its own, so its drain dies
 *    with it;
 * 105 two projects sharing a folder share one inbox;
 * 107 a removed project's turn service is still served.
 * Row 106 (a folder change reaches the next turn) is project-extra-folders.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
	PubSub,
	Scope,
	Stream,
} from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	addWithoutRelay,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ProjectServices } from "../../../src/lib/domain/daemon/Services/project-services.js";
import { SessionActivityTag } from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { RateLimiterTag } from "../../../src/lib/domain/project-services/Layers/rate-limiter-layer.js";
import { AlertsTag } from "../../../src/lib/domain/project-services/Services/alerts.js";
import { DirectoryListingServiceTag } from "../../../src/lib/domain/project-services/Services/directory-listing-service.js";
import { GoalSummaryServiceTag } from "../../../src/lib/domain/project-services/Services/goal-summary-service.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/project-services/Services/pending-interaction-service.js";
import { ProjectSettingsTag } from "../../../src/lib/domain/project-services/Services/project-settings.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import {
	ProviderTurnServiceTag,
	ProviderTurns,
} from "../../../src/lib/domain/project-services/Services/provider-turn-service.js";
import { RecapServiceTag } from "../../../src/lib/domain/project-services/Services/recap-service.js";
import {
	AgentLivenessTag,
	ConfigTag,
	OpenCodeFileServiceTag,
	OpenCodeSettingsServiceTag,
	PollerManagerTag,
	TranslatorTag,
} from "../../../src/lib/domain/project-services/Services/services.js";
import { SessionInboxTag } from "../../../src/lib/domain/project-services/Services/session-inbox.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/project-services/Services/session-title-service.js";
import { SessionWorkspaceHintStateTag } from "../../../src/lib/domain/project-services/Services/session-workspace-hint-state.js";
import { SSEStreamTag } from "../../../src/lib/domain/project-services/Services/sse-stream-service.js";
import { OpenCodeTerminalServiceTag } from "../../../src/lib/domain/project-services/Services/terminal-service.js";
import { ToolContentServiceTag } from "../../../src/lib/domain/project-services/Services/tool-content-service.js";
import { ProjectRpcContextsTag } from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { MessagePollerManager } from "../../../src/lib/provider/opencode/message-poller-impl.js";
import {
	makeRoutedWsRpcServerLayer,
	WsRpcGroup,
} from "../../../src/lib/server/ws-rpc.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const artifacts = join(process.cwd(), "test-results");
const evidence: {
	scenario?: string | undefined;
	observed: Record<string, unknown>;
} = { observed: {} };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async (context) => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	if (!evidence.scenario) return;
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(
		join(artifacts, `82tn-16-project-ingestion-${evidence.scenario}.json`),
		`${JSON.stringify(
			{
				scenario: evidence.scenario,
				result: context.task.result?.state,
				failures: context.task.result?.errors?.map((error) => error.message),
				observed: evidence.observed,
			},
			null,
			2,
		)}\n`,
	);
	evidence.scenario = undefined;
	evidence.observed = {};
});

const created = (sessionId: string) =>
	providerRuntimeEvent(
		"session.created",
		sessionId,
		{ sessionId, title: sessionId, provider: "claude" },
		{ eventId: `${sessionId}-created` },
	);

/** A whole Claude turn for `sessionId`, ending in turn.completed. */
const turn = (sessionId: string) =>
	Effect.gen(function* () {
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const runId = `${sessionId}-r1`;
		yield* ingestion.ingest(created(sessionId));
		yield* ingestion.ingest(
			providerRuntimeEvent(
				"message.created",
				sessionId,
				{ messageId: `${sessionId}-u1`, sessionId, role: "user" },
				{ eventId: `${sessionId}-user`, runId },
			),
		);
		yield* ingestion.ingest(
			providerRuntimeEvent(
				"run.started",
				sessionId,
				{ inputId: `${sessionId}-u1`, requestedRunId: runId },
				{ eventId: `${sessionId}-run`, runId },
			),
		);
		yield* ingestion.ingest(
			providerRuntimeEvent(
				"message.created",
				sessionId,
				{
					messageId: `${sessionId}-m1`,
					sessionId,
					role: "assistant",
					parentID: `${sessionId}-u1`,
				},
				{ eventId: `${sessionId}-assistant`, runId },
			),
		);
		yield* ingestion.ingest(
			providerRuntimeEvent(
				"turn.completed",
				sessionId,
				{ messageId: `${sessionId}-m1` },
				{ eventId: `${sessionId}-done`, runId },
			),
		);
	});

const start = (scenario: string) => {
	evidence.scenario = scenario;
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "conduit-project-ingest-")),
	);
	const folder = join(root, "repo");
	mkdirSync(folder);
	execFileSync("git", ["init", "-q", "-b", "main", folder]);
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const running = new Set<ManagedRuntime.ManagedRuntime<unknown, unknown>>();
	cleanups.push(async () => {
		for (const daemon of running) await daemon.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const project = (slug: string) => ({
		slug,
		title: slug,
		folders: [folder] as const,
		lastUsed: 1,
	});
	const boot = () => {
		const daemon = ManagedRuntime.make(
			makeDaemonLive({
				configDir,
				socketPath: join(configDir, "relay.sock"),
				staticDir: root,
				launchLogin: sdkDefaultClaudeConfigDir(join(root, "home", ".claude")),
				initialConfig: makeDaemonConfigFromOptions({
					port: 0,
					host: "127.0.0.1",
					tlsEnabled: false,
					hostExplicit: true,
				}),
				smartDefault: false,
			}).pipe(Layer.provide(NodePath.layer)),
		);
		running.add(daemon as ManagedRuntime.ManagedRuntime<unknown, unknown>);
		const register = (slug: string) =>
			daemon.runPromise(addWithoutRelay(project(slug), { silent: true }));
		/** Run `use` in the project's daemon-built context; no relay starts. */
		const inProject = <A, E, R>(slug: string, use: Effect.Effect<A, E, R>) =>
			daemon.runPromise(
				Effect.flatMap(ProjectServices, (projects) =>
					Effect.flatMap(projects.forProject(slug), (context) =>
						// Whatever `use` needs must come from the project's context.
						Effect.provide(use, context as Context.Context<R>),
					),
				),
			);
		/** Open the project, as a tab or a folder change does; `stop` closes it. */
		const relay = async (slug: string) => {
			const context = await daemon.runPromise(
				Effect.flatMap(ProjectServices, (projects) => projects.open(slug)),
			);
			return {
				run: <A, E, R>(use: Effect.Effect<A, E, R>) =>
					daemon.runPromise(Effect.provide(use, context as Context.Context<R>)),
				stop: () =>
					daemon.runPromise(
						Effect.flatMap(ProjectServices, (projects) => projects.close(slug)),
					),
			};
		};
		const sql = <A>(
			use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>,
		) => daemon.runPromise(Effect.flatMap(SqlClient.SqlClient, use));
		const stop = async () => {
			running.delete(daemon as ManagedRuntime.ManagedRuntime<unknown, unknown>);
			await daemon.dispose();
		};
		return { daemon, register, inProject, relay, sql, stop };
	};
	return { boot };
};

describe("82tn.16: each project's ingestion side lives with the project", () => {
	it("ingests a project's provider events with no relay open", async () => {
		const daemon = start("cold").boot();
		await daemon.register("alpha");
		await daemon.inProject(
			"alpha",
			Effect.flatMap(ProviderRuntimeIngestionTag, (ingestion) =>
				ingestion.ingest(created("c1")),
			),
		);
		const observed = {
			rows: await daemon.sql(
				(sql) => sql`SELECT id, project_id FROM sessions ORDER BY id`,
			),
		};
		evidence.observed = observed;
		expect(observed.rows).toEqual([{ id: "c1", project_id: "alpha" }]);
	});

	it("keeps two projects' translators and ingestion apart", async () => {
		const daemon = start("shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		// A sessionless part, as OpenCode sends some part updates.
		const part = {
			type: "message.part.updated",
			properties: { part: { id: "p1", type: "reasoning", messageID: "m1" } },
		} as const;
		const seen = (slug: string, translate: boolean) =>
			daemon.inProject(
				slug,
				Effect.gen(function* () {
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* ingestion.ingest(created(`${slug}-1`));
					const translator = yield* TranslatorTag;
					if (translate) translator.translate(part);
					return [...(translator.getSeenParts()?.keys() ?? [])];
				}),
			);
		const observed = {
			alpha: await seen("alpha", true),
			beta: await seen("beta", false),
			rows: await daemon.sql(
				(sql) => sql`SELECT id, project_id FROM sessions ORDER BY id`,
			),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			alpha: ["p1"],
			beta: [],
			rows: [
				{ id: "alpha-1", project_id: "alpha" },
				{ id: "beta-1", project_id: "beta" },
			],
		});
	});

	it("keeps a pending permission across a relay replaced while registered", async () => {
		const daemon = start("relay-replaced").boot();
		await daemon.register("alpha");
		const first = await daemon.relay("alpha");
		await first.run(
			Effect.flatMap(PendingInteractionServiceTag, (pending) =>
				pending.recordPermissionRequest({
					requestId: "perm-1" as PermissionId,
					sessionId: "s1",
					toolName: "Bash",
					toolInput: { command: "ls" },
				}),
			),
		);
		await first.stop();
		const second = await daemon.relay("alpha");
		const pending = Effect.flatMap(PendingInteractionServiceTag, (service) =>
			service
				.listPendingPermissions()
				.pipe(Effect.map((rows) => rows.map(({ requestId }) => requestId))),
		);
		const observed = {
			relay: await second.run(pending),
			project: await daemon.inProject("alpha", pending),
		};
		await second.stop();
		evidence.observed = observed;
		expect(observed).toEqual({ relay: ["perm-1"], project: ["perm-1"] });
	});

	it("raises no alert for a viewed session's turn end", async () => {
		const daemon = start("viewed").boot();
		await daemon.register("alpha");
		const relay = await daemon.relay("alpha");
		const alerts = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const subscribed = yield* PubSub.subscribe(yield* AlertsTag);
				// A browser's session detail subscription on the daemon socket.
				const activity = yield* SessionActivityTag;
				yield* activity.view("viewed");
				yield* Effect.promise(() =>
					relay.run(Effect.andThen(turn("viewed"), turn("unviewed"))),
				);
				return [
					...(yield* PubSub.takeUpTo(subscribed, Number.POSITIVE_INFINITY)),
				].map((alert) => ("sessionId" in alert ? alert.sessionId : alert));
			}).pipe(Effect.scoped),
		);
		await relay.stop();
		evidence.observed = { alerts };
		expect(alerts).toEqual(["unviewed"]);
	});

	it("clears a project's history proof on its first use after a restart", async () => {
		const harness = start("restart");
		const first = harness.boot();
		await first.register("alpha");
		const relay = await first.relay("alpha");
		await relay.run(
			Effect.flatMap(ProviderRuntimeIngestionTag, (ingestion) =>
				ingestion.ingest(created("s1")),
			),
		);
		await relay.stop();
		await first.sql(
			(sql) => sql`UPDATE sessions SET history_complete = 1 WHERE id = 's1'`,
		);
		await first.stop();
		const second = harness.boot();
		await second.register("alpha");
		await second.inProject("alpha", Effect.void);
		const observed = {
			rows: await second.sql(
				(sql) => sql`SELECT id, history_complete FROM sessions`,
			),
		};
		evidence.observed = observed;
		expect(observed.rows).toEqual([{ id: "s1", history_complete: 0 }]);
	});
});

/** The project's settings and titles, as a call naming it sees them. */
const titleParts = Effect.all({
	settings: ProjectSettingsTag,
	titles: SessionTitleServiceTag,
});

/** The same parts as the opened project's context holds them. */
const relayParts = <A, R>(
	relay: {
		readonly run: <A, E, R>(use: Effect.Effect<A, E, R>) => Promise<A>;
	},
	parts: Effect.Effect<A, never, R>,
) => relay.run(parts);

describe("82tn.16: each project's settings and titles live with the project", () => {
	it("serves a project's settings and titles with no relay open", async () => {
		const daemon = start("titles-cold").boot();
		await daemon.register("alpha");
		const parts = await daemon.inProject("alpha", titleParts);
		const observed = {
			settings: parts.settings !== undefined,
			titles: parts.titles !== undefined,
		};
		evidence.observed = observed;
		expect(observed).toEqual({ settings: true, titles: true });
	});

	it("keeps one settings and title service across a relay replaced while registered", async () => {
		const daemon = start("titles-relay-replaced").boot();
		await daemon.register("alpha");
		const project = await daemon.inProject("alpha", titleParts);
		const first = await daemon.relay("alpha");
		const firstParts = await relayParts(first, titleParts);
		await first.stop();
		const second = await daemon.relay("alpha");
		const secondParts = await relayParts(second, titleParts);
		await second.stop();
		const same = (parts: typeof project) =>
			parts.settings === project.settings && parts.titles === project.titles;
		const observed = { first: same(firstParts), second: same(secondParts) };
		evidence.observed = observed;
		expect(observed).toEqual({ first: true, second: true });
	});

	it("keeps two projects sharing a folder apart", async () => {
		const daemon = start("titles-shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.inProject(
			"alpha",
			Effect.tap(titleParts, ({ settings }) => settings.browsers.add(1)),
		);
		const beta = await daemon.inProject("beta", titleParts);
		const observed = {
			titles: alpha.titles === beta.titles,
			betaBrowsers: beta.settings.browsers.count(),
		};
		evidence.observed = observed;
		expect(observed).toEqual({ titles: false, betaBrowsers: 0 });
	});
});

/** The project's tool details, directory listing and agent liveness. */
const readerParts = Effect.all({
	tools: ToolContentServiceTag,
	directories: DirectoryListingServiceTag,
	liveness: AgentLivenessTag,
});

describe("82tn.16: each project's tool details, directory listing and agent liveness live with the project", () => {
	it("serves them with no relay open", async () => {
		const daemon = start("readers-cold").boot();
		await daemon.register("alpha");
		const observed = await daemon.inProject(
			"alpha",
			Effect.gen(function* () {
				const { tools, liveness } = yield* readerParts;
				return {
					details: yield* tools.details("absent", ["tool-1"]),
					live: yield* liveness("absent"),
				};
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ details: [], live: false });
	});

	it("keeps one of each across a relay replaced while registered", async () => {
		const daemon = start("readers-relay-replaced").boot();
		await daemon.register("alpha");
		const project = await daemon.inProject("alpha", readerParts);
		const inRelay = async () => {
			const relay = await daemon.relay("alpha");
			const parts = await relayParts(relay, readerParts);
			await relay.stop();
			return (
				parts.tools === project.tools &&
				parts.directories === project.directories &&
				parts.liveness === project.liveness
			);
		};
		const observed = { first: await inRelay(), second: await inRelay() };
		evidence.observed = observed;
		expect(observed).toEqual({ first: true, second: true });
	});

	it("gives two projects sharing a folder their own tool-details reader", async () => {
		const daemon = start("readers-shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.inProject("alpha", readerParts);
		const beta = await daemon.inProject("beta", readerParts);
		const observed = { sameTools: alpha.tools === beta.tools };
		evidence.observed = observed;
		expect(observed).toEqual({ sameTools: false });
	});
});

/** The project's turn service and inbox. */
const turnParts = Effect.all({
	turns: ProviderTurnServiceTag,
	inbox: SessionInboxTag,
});

describe("82tn.16: each project's turns and inbox live with the project", () => {
	it("serves a project's turns and inbox with no relay open", async () => {
		const daemon = start("turns-cold").boot();
		await daemon.register("alpha");
		const observed = await daemon.inProject(
			"alpha",
			Effect.map(turnParts, ({ turns, inbox }) => ({
				fences: turns.turnFences("absent"),
				inbox: inbox !== undefined,
			})),
		);
		evidence.observed = observed;
		expect(observed).toEqual({
			fences: { stopping: false, switching: false },
			inbox: true,
		});
	});

	it("keeps one turn service and inbox across a relay replaced while registered", async () => {
		const daemon = start("turns-relay-replaced").boot();
		await daemon.register("alpha");
		const project = await daemon.inProject("alpha", turnParts);
		const inRelay = async () => {
			const relay = await daemon.relay("alpha");
			const parts = await relayParts(relay, turnParts);
			await relay.stop();
			return parts.turns === project.turns && parts.inbox === project.inbox;
		};
		const observed = { first: await inRelay(), second: await inRelay() };
		evidence.observed = observed;
		expect(observed).toEqual({ first: true, second: true });
	});

	it("gives two projects sharing a folder their own turns and inbox", async () => {
		const daemon = start("turns-shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.inProject("alpha", turnParts);
		const beta = await daemon.inProject("beta", turnParts);
		const observed = {
			sameTurns: alpha.turns === beta.turns,
			sameInbox: alpha.inbox === beta.inbox,
		};
		evidence.observed = observed;
		expect(observed).toEqual({ sameTurns: false, sameInbox: false });
	});

	it("drops a removed project's turn service", async () => {
		const daemon = start("turns-removed").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turnParts);
		const served = () =>
			daemon.daemon.runPromise(
				Effect.map(ProviderTurns, (turns) =>
					Option.isSome(turns.served("alpha")),
				),
			);
		const before = await served();
		await daemon.daemon.runPromise(remove("alpha"));
		const observed = { before, after: await served() };
		evidence.observed = observed;
		expect(observed).toEqual({ before: true, after: false });
	});
});

describe("82tn.16: each project's terminals live with the project", () => {
	it("serves a project's terminals with no relay open", async () => {
		const daemon = start("terminals-cold").boot();
		await daemon.register("alpha");
		const snapshot = await daemon.inProject(
			"alpha",
			Effect.map(OpenCodeTerminalServiceTag, (terminal) => terminal.snapshot()),
		);
		evidence.observed = { snapshot };
		expect(evidence.observed).toEqual({ snapshot: [] });
	});

	it("keeps one terminal service across a relay replaced while registered", async () => {
		const daemon = start("terminals-relay-replaced").boot();
		await daemon.register("alpha");
		const project = await daemon.inProject("alpha", OpenCodeTerminalServiceTag);
		const inRelay = async () => {
			const relay = await daemon.relay("alpha");
			const terminal = await relayParts(relay, OpenCodeTerminalServiceTag);
			await relay.stop();
			return terminal === project;
		};
		const observed = { first: await inRelay(), second: await inRelay() };
		evidence.observed = observed;
		expect(observed).toEqual({ first: true, second: true });
	});

	it("gives two projects sharing a folder their own terminal service", async () => {
		const daemon = start("terminals-shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.inProject("alpha", OpenCodeTerminalServiceTag);
		const beta = await daemon.inProject("beta", OpenCodeTerminalServiceTag);
		evidence.observed = { same: alpha === beta };
		expect(evidence.observed).toEqual({ same: false });
	});

	it("drops a removed project's terminal service", async () => {
		const daemon = start("terminals-removed").boot();
		await daemon.register("alpha");
		const before = await daemon.inProject("alpha", OpenCodeTerminalServiceTag);
		await daemon.daemon.runPromise(remove("alpha"));
		await daemon.register("alpha");
		const after = await daemon.inProject("alpha", OpenCodeTerminalServiceTag);
		evidence.observed = { same: before === after };
		expect(evidence.observed).toEqual({ same: false });
	});
});

describe("82tn.16: one send limiter for the daemon", () => {
	it("keeps a tab's send window across a relay replaced while registered", async () => {
		const daemon = start("send-limit-relay-replaced").boot();
		await daemon.register("alpha");
		const send = Effect.flatMap(RateLimiterTag, (limiter) =>
			Effect.map(limiter.checkLimit("tab-1"), ({ allowed }) => allowed),
		);
		const sendsIn = async (count: number) => {
			const relay = await daemon.relay("alpha");
			const allowed: boolean[] = [];
			for (let sent = 0; sent < count; sent++)
				allowed.push(await relayParts(relay, send));
			await relay.stop();
			return allowed;
		};
		const observed = { first: await sendsIn(5), second: await sendsIn(1) };
		evidence.observed = observed;
		expect(observed).toEqual({
			first: [true, true, true, true, true],
			second: [false],
		});
	});
});

describe("82tn.16: workspace hint dismissals live with the daemon", () => {
	it("keeps a dismissal made with no relay open for the relay opened after", async () => {
		const daemon = start("hint-dismissal-cold").boot();
		await daemon.register("alpha");
		await daemon.inProject(
			"alpha",
			Effect.map(SessionWorkspaceHintStateTag, (dismissals) => {
				dismissals.set("session-1", 3);
			}),
		);
		const relay = await daemon.relay("alpha");
		const observed = {
			relaySees: await relayParts(
				relay,
				Effect.map(SessionWorkspaceHintStateTag, (dismissals) =>
					dismissals.get("session-1"),
				),
			),
		};
		await relay.stop();
		evidence.observed = observed;
		expect(observed).toEqual({ relaySees: 3 });
	});
});

describe("82tn.16: each project's OpenCode file and catalog readers live with the project", () => {
	const readers = Effect.all({
		files: OpenCodeFileServiceTag,
		settings: OpenCodeSettingsServiceTag,
	});
	it("serves them with no relay open, and a replaced relay reads the same ones", async () => {
		const daemon = start("opencode-readers").boot();
		await daemon.register("alpha");
		const cold = await daemon.inProject("alpha", readers);
		const catalog = await daemon.inProject(
			"alpha",
			cold.settings.listCatalog({ startIfStopped: false }),
		);
		const sameIn = async () => {
			const relay = await daemon.relay("alpha");
			const held = await relayParts(relay, readers);
			await relay.stop();
			return held.files === cold.files && held.settings === cold.settings;
		};
		const observed = {
			catalog,
			firstRelay: await sameIn(),
			replacedRelay: await sameIn(),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			catalog: { commands: [], skills: [] },
			firstRelay: true,
			replacedRelay: true,
		});
	});
});

describe("82tn.16: each project's recaps and goal summaries live with the project", () => {
	const summaries = Effect.all({
		recaps: RecapServiceTag,
		goals: GoalSummaryServiceTag,
	});
	it("serves them with no relay open, a replaced relay reads the same ones, and a re-added project gets fresh ones", async () => {
		const daemon = start("recap-goal-summary").boot();
		await daemon.register("alpha");
		const cold = await daemon.inProject("alpha", summaries);
		const sameIn = async () => {
			const relay = await daemon.relay("alpha");
			const held = await relayParts(relay, summaries);
			await relay.stop();
			return held.recaps === cold.recaps && held.goals === cold.goals;
		};
		const firstRelay = await sameIn();
		const replacedRelay = await sameIn();
		await daemon.daemon.runPromise(remove("alpha"));
		await daemon.register("alpha");
		const readded = await daemon.inProject("alpha", summaries);
		const observed = {
			firstRelay,
			replacedRelay,
			readdedIsFresh:
				readded.recaps !== cold.recaps && readded.goals !== cold.goals,
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			firstRelay: true,
			replacedRelay: true,
			readdedIsFresh: true,
		});
	});
});

/** A browser tab: its own routed RPC client, as its socket is routed, open until `close`. */
const openTab = Effect.gen(function* () {
	const scope = yield* Scope.make();
	const resolve = yield* ProjectRpcContextsTag;
	const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
		Effect.provide(makeRoutedWsRpcServerLayer(resolve)),
		Scope.provide(scope),
	);
	return {
		/** Opens the session's detail stream, as a tab showing it does. */
		show: (sessionId: string) =>
			Effect.gen(function* () {
				const live = yield* Deferred.make<void>();
				yield* client.SubscribeSessionDetail({ sessionId }).pipe(
					Stream.tap(() => Deferred.succeed(live, undefined)),
					Stream.runDrain,
					Effect.forkIn(scope),
				);
				yield* Deferred.await(live);
			}),
		pick: (sessionId: string, originId: string) =>
			client.ViewSession({ sessionId, originId }),
		close: Scope.close(scope, Exit.void),
	};
});

/**
 * Lane 16p (audit.md rows 126-130): one daemon record of which tabs view which
 * session, and which session each tab picked last in each project, as t3code
 * keeps one server-wide subscriber map whose entries leave with their scope
 * (apps/server/src/orchestration-v2/CommandOutputHub.ts:170-191).
 */
describe("82tn.16: the daemon records which tabs view which session", () => {
	it("keeps a tab's pick across a relay replaced while registered", async () => {
		const daemon = start("pick-relay-replaced").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("viewed"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const tab = yield* openTab;
				yield* tab.show("viewed");
				yield* tab.pick("viewed", "tab-1");
				const activity = yield* SessionActivityTag;
				const viewed = activity.hasViewers("viewed");
				const projects = yield* ProjectServices;
				yield* projects.close("alpha");
				yield* projects.open("alpha");
				const result = {
					viewed,
					picked: activity.selectedSession("alpha", "tab-1"),
				};
				yield* tab.close;
				return result;
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ viewed: true, picked: "viewed" });
	});

	it("counts two tabs viewing one session until both leave", async () => {
		const daemon = start("viewers-two-tabs").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("s1"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const activity = yield* SessionActivityTag;
				const first = yield* openTab;
				const second = yield* openTab;
				yield* first.show("s1");
				yield* second.show("s1");
				const both = activity.hasViewers("s1");
				yield* first.close;
				const one = activity.hasViewers("s1");
				yield* second.close;
				return { both, one, none: activity.hasViewers("s1") };
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ both: true, one: true, none: false });
	});

	it("keeps one tab's picks in two projects apart", async () => {
		const daemon = start("viewers-two-projects").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		await daemon.inProject("alpha", turn("alpha-1"));
		await daemon.inProject("beta", turn("beta-1"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const activity = yield* SessionActivityTag;
				const tab = yield* openTab;
				yield* tab.pick("alpha-1", "tab-1");
				yield* tab.pick("beta-1", "tab-1");
				yield* tab.close;
				return {
					alpha: activity.selectedSession("alpha", "tab-1"),
					beta: activity.selectedSession("beta", "tab-1"),
				};
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ alpha: "alpha-1", beta: "beta-1" });
	});

	it("drops a removed project's picks", async () => {
		const daemon = start("viewers-removed").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("s1"));
		await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const tab = yield* openTab;
				yield* tab.pick("s1", "tab-1");
				yield* tab.close;
			}),
		);
		await daemon.daemon.runPromise(remove("alpha"));
		await daemon.register("alpha");
		await daemon.inProject("alpha", Effect.void);
		const observed = {
			picked: await daemon.daemon.runPromise(
				Effect.map(SessionActivityTag, (activity) =>
					activity.selectedSession("alpha", "tab-1"),
				),
			),
		};
		evidence.observed = observed;
		expect(observed).toEqual({ picked: undefined });
	});

	it("keeps a tab's pick across a reconnect", async () => {
		const daemon = start("viewers-reconnect").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("s1"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const activity = yield* SessionActivityTag;
				const before = yield* openTab;
				yield* before.show("s1");
				yield* before.pick("s1", "tab-1");
				yield* before.close;
				const dropped = activity.hasViewers("s1");
				const after = yield* openTab;
				const picked = activity.selectedSession("alpha", "tab-1");
				yield* after.show("s1");
				const viewed = activity.hasViewers("s1");
				yield* after.close;
				return { dropped, picked, viewed };
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ dropped: false, picked: "s1", viewed: true });
	});
});

/**
 * Lane 16p (audit.md rows 131-135): one message poller per project, built with the
 * project's generation and reading the daemon's viewer record, as t3code keeps one
 * server-wide owner per concern whose entries leave with their scope
 * (apps/server/src/orchestration-v2/CommandOutputHub.ts:170-191).
 */
describe("82tn.16: one message poller per project", () => {
	it("keeps one poller across a relay replaced while registered, and a removed project's stops", async () => {
		const daemon = start("poller-relay-replaced").boot();
		await daemon.register("alpha");
		const cold = await daemon.inProject("alpha", PollerManagerTag);
		cold.startPolling("s1");
		const sameIn = async () => {
			const relay = await daemon.relay("alpha");
			const held = await relayParts(relay, PollerManagerTag);
			await relay.stop();
			return held === cold;
		};
		const firstRelay = await sameIn();
		const replacedRelay = await sameIn();
		const pollingWithNoRelay = cold.isPolling("s1");
		await daemon.daemon.runPromise(remove("alpha"));
		const pollingAfterRemove = cold.isPolling("s1");
		await daemon.register("alpha");
		const readded = await daemon.inProject("alpha", PollerManagerTag);
		const observed = {
			firstRelay,
			replacedRelay,
			pollingWithNoRelay,
			pollingAfterRemove,
			readdedIsFresh: readded !== cold,
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			firstRelay: true,
			replacedRelay: true,
			pollingWithNoRelay: true,
			pollingAfterRemove: false,
			readdedIsFresh: true,
		});
	});

	it("keeps two projects' polling apart when they share a folder", async () => {
		const daemon = start("poller-shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.inProject("alpha", PollerManagerTag);
		const beta = await daemon.inProject("beta", PollerManagerTag);
		alpha.startPolling("s1");
		const observed = {
			distinct: alpha !== beta,
			alpha: alpha.isPolling("s1"),
			beta: beta.isPolling("s1"),
		};
		alpha.stopPolling("s1");
		evidence.observed = observed;
		expect(observed).toEqual({ distinct: true, alpha: true, beta: false });
	});

	it("counts a session as viewed only while a tab shows it", async () => {
		const daemon = start("poller-viewers").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("viewed"));
		const poller = await daemon.inProject("alpha", PollerManagerTag);
		const viewers = (sessionId: string) =>
			poller instanceof MessagePollerManager
				? poller.hasViewers(sessionId)
				: "not a MessagePollerManager";
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const before = viewers("viewed");
				const tab = yield* openTab;
				yield* tab.show("viewed");
				const shown = viewers("viewed");
				const other = viewers("unviewed");
				yield* tab.close;
				return { before, shown, other, after: viewers("viewed") };
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({
			before: false,
			shown: true,
			other: false,
			after: false,
		});
	});
});

/**
 * Lane 16p (audit.md rows 136-140): a project's RPCs run on the daemon's
 * project context, never a relay's, as t3code serves every RPC from one server
 * runtime and each command names its thread
 * (apps/server/src/orchestration-v2/Orchestrator.ts:1910).
 */
describe("82tn.16: a project's RPCs run on the daemon's project context", () => {
	it("keeps a tab's detail stream across a relay replaced while registered", async () => {
		const daemon = start("rpc-stream-relay-replaced").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("viewed"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const tab = yield* openTab;
				yield* tab.show("viewed");
				const activity = yield* SessionActivityTag;
				const projects = yield* ProjectServices;
				yield* projects.close("alpha");
				yield* projects.open("alpha");
				const result = { viewed: activity.hasViewers("viewed") };
				yield* tab.close;
				return { ...result, afterClose: activity.hasViewers("viewed") };
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ viewed: true, afterClose: false });
	});

	it("ends a removed project's streams", async () => {
		const daemon = start("rpc-stream-removed").boot();
		await daemon.register("alpha");
		await daemon.inProject("alpha", turn("viewed"));
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const tab = yield* openTab;
				yield* tab.show("viewed");
				const activity = yield* SessionActivityTag;
				const shown = activity.hasViewers("viewed");
				yield* remove("alpha");
				const result = { shown, afterRemove: activity.hasViewers("viewed") };
				yield* tab.close;
				return result;
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({ shown: true, afterRemove: false });
	});

	it("serves each project from its own context, with its own stream and poller", async () => {
		const daemon = start("rpc-context-no-relay").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		const alphaPoller = await daemon.inProject("alpha", PollerManagerTag);
		const alphaStream = await daemon.inProject("alpha", SSEStreamTag);
		const observed = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const resolve = yield* ProjectRpcContextsTag;
				const alpha = yield* resolve("alpha");
				const beta = yield* resolve("beta");
				return {
					alpha: Context.get(alpha, ConfigTag).slug,
					beta: Context.get(beta, ConfigTag).slug,
					projectPoller: Context.get(alpha, PollerManagerTag) === alphaPoller,
					projectStream: Context.get(alpha, SSEStreamTag) === alphaStream,
					sharedStream: Context.get(beta, SSEStreamTag) === alphaStream,
				};
			}),
		);
		evidence.observed = observed;
		expect(observed).toEqual({
			alpha: "alpha",
			beta: "beta",
			projectPoller: true,
			projectStream: true,
			sharedStream: false,
		});
	});
});
