import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect, vi } from "vitest";
import {
	type ProjectSettingsEnvelope,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { publishProjectSetting } from "../../../src/lib/domain/relay/Services/project-settings.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

// ni8.12 C: project-global settings are peer-notification facts. Another tab,
// or the CLI over the same RPC contract, changes one; every open subscriber on
// the project has to hear it with no refetch.

const makeLayer = () => {
	const api = makeMockOpenCodeAPI();
	api.provider.list = vi.fn(async () => ({
		connected: ["openai"],
		defaults: {},
		providers: [
			{
				id: "openai",
				name: "OpenAI",
				models: [
					{
						id: "gpt-4",
						name: "GPT-4",
						variants: { standard: {}, fast: {} },
					},
				],
			},
		],
	})) as typeof api.provider.list;
	api.config.update = vi.fn(async () => undefined) as typeof api.config.update;
	const configDir = mkdtempSync(join(tmpdir(), "conduit-project-settings-"));
	saveRelaySettings(
		{
			defaultVariants: { "openai/gpt-4": "fast" },
			hiddenModels: ["openai/gpt-3"],
		},
		configDir,
	);
	return WsRpcServerLayer.pipe(
		Layer.provideMerge(
			makeTestHandlerLayer({ api, config: makeMockConfig({ configDir }) }),
		),
	);
};

const open = Effect.gen(function* () {
	const client = yield* RpcTest.makeClient(WsRpcGroup);
	const subscribe = Effect.gen(function* () {
		const q = yield* Queue.unbounded<ProjectSettingsEnvelope>();
		yield* Stream.runForEach(
			client.SubscribeProjectSettings({ projectSlug: "project" }),
			(envelope) => Queue.offer(q, envelope),
		).pipe(Effect.forkScoped);
		const snapshot = yield* Queue.take(q);
		expect(yield* Queue.take(q)).toEqual({ _tag: "synchronized" });
		return { q, snapshot };
	});
	return { client, subscribe };
});

describe("SubscribeProjectSettings", () => {
	it.scoped("opens with a snapshot of every current project setting", () =>
		Effect.gen(function* () {
			const { subscribe } = yield* open;
			const { snapshot } = yield* subscribe;
			if (snapshot._tag !== "snapshot") throw new Error("expected snapshot");
			expect(snapshot.rows).toEqual(
				expect.arrayContaining([
					{ _tag: "defaultModel", variant: "" },
					{
						_tag: "visibility",
						hiddenModels: ["openai/gpt-3"],
						hiddenAgents: [],
					},
					{ _tag: "defaultPermissionMode", mode: "ask" },
					{ _tag: "claudeSettings", overrides: {} },
				]),
			);
		}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped("a visibility change in one tab reaches every open tab", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const tabA = yield* subscribe;
			const tabB = yield* subscribe;

			yield* client.SetHiddenEntries({
				projectSlug: "project",
				hiddenModels: ["openai/gpt-4"],
				originId: "tab-a",
			});

			for (const { q } of [tabA, tabB]) {
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: {
						_tag: "visibility",
						hiddenModels: ["openai/gpt-4"],
						hiddenAgents: [],
					},
				});
			}
		}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped(
		"a default-model change made with no browser (CLI) reaches an open tab",
		() =>
			Effect.gen(function* () {
				const { client, subscribe } = yield* open;
				const { q } = yield* subscribe;

				// The CLI speaks this same contract over the Unix socket, no originId.
				yield* client.SetDefaultModel({
					projectSlug: "project",
					model: "gpt-4",
					provider: "openai",
				});

				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: {
						_tag: "defaultModel",
						model: "gpt-4",
						provider: "openai",
						variant: "fast",
					},
				});
			}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped("a default approval-mode change reaches an open tab", () =>
		Effect.gen(function* () {
			const { client, subscribe } = yield* open;
			const { q } = yield* subscribe;

			yield* client.SetDefaultPermissionMode({
				projectSlug: "project",
				mode: "acceptEdits",
			});

			expect(yield* Queue.take(q)).toMatchObject({
				_tag: "upsert",
				item: { _tag: "defaultPermissionMode", mode: "acceptEdits" },
			});
		}).pipe(Effect.provide(makeLayer())),
	);
});

// ni8.15 / ni8.40: live project facts ride the same subscription. The relay
// publishes them as they change; a tab that opens later still sees the latest.
describe("SubscribeProjectSettings live facts", () => {
	it.scoped(
		"the browser count and OpenCode upstream state reach open tabs and later snapshots",
		() =>
			Effect.gen(function* () {
				const { subscribe } = yield* open;
				const early = yield* subscribe;
				if (early.snapshot._tag !== "snapshot") throw new Error("snapshot");
				expect(early.snapshot.rows.map((row) => row._tag)).not.toContain(
					"opencodeConnection",
				);

				yield* publishProjectSetting({ _tag: "clientCount", count: 2 });
				yield* publishProjectSetting({
					_tag: "opencodeConnection",
					status: "reconnecting",
				});

				expect(yield* Queue.take(early.q)).toMatchObject({
					_tag: "upsert",
					item: { _tag: "clientCount", count: 2 },
				});
				expect(yield* Queue.take(early.q)).toMatchObject({
					_tag: "upsert",
					item: { _tag: "opencodeConnection", status: "reconnecting" },
				});

				const late = yield* subscribe;
				if (late.snapshot._tag !== "snapshot") throw new Error("snapshot");
				expect(late.snapshot.rows).toEqual(
					expect.arrayContaining([
						{ _tag: "clientCount", count: 2 },
						{ _tag: "opencodeConnection", status: "reconnecting" },
					]),
				);
			}).pipe(Effect.provide(makeLayer())),
	);
});
