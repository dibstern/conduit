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
import { type Context, Effect, Layer, ManagedRuntime, PubSub } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { RelayFactoryTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { addWithoutRelay } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ProjectServices } from "../../../src/lib/domain/daemon/Services/project-services.js";
import { SessionActivityTag } from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { AlertsTag } from "../../../src/lib/domain/relay/Services/alerts.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { TranslatorTag } from "../../../src/lib/domain/relay/Services/services.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
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
		const relay = (slug: string) =>
			daemon.runPromise(
				Effect.flatMap(RelayFactoryTag, (factory) =>
					factory.create(project(slug)),
				),
			);
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
		await first.effectRuntime.runtime.runPromise(
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
			relay: await second.effectRuntime.runtime.runPromise(pending),
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
				activity.viewers.set("viewed", 1);
				yield* Effect.promise(() =>
					relay.effectRuntime.runtime.runPromise(
						Effect.andThen(turn("viewed"), turn("unviewed")),
					),
				);
				activity.viewers.delete("viewed");
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
		await relay.effectRuntime.runtime.runPromise(
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
