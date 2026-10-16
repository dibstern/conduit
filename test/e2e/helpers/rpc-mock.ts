import { RpcSchema } from "@effect/rpc";
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import {
	type Alert,
	GetAgentsResponseSchema,
	GetCommandsResponseSchema,
	GetModelsResponseSchema,
	GetProjectsResponseSchema,
	type GetStatusResponse,
	type ProjectSetting,
	WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { makeRpcStream, serveRpc } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import {
	mockDetailPage,
	mockDetailSnapshot,
	subscribeMockDetail,
} from "./detail-projection-mock.js";

interface JsonRpcRequest {
	readonly jsonrpc?: "2.0";
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

interface EffectRpcRequest {
	readonly _tag: "Request";
	readonly id: string;
	readonly tag: string;
	readonly payload?: Record<string, unknown>;
}

type RpcHandler = (
	params: Record<string, unknown>,
	request: JsonRpcRequest | EffectRpcRequest,
) => unknown | Promise<unknown>;

export const MOCK_SERVER_STATUS: GetStatusResponse = {
	uptime: 273_600,
	version: "0.42.1",
	port: 2633,
	host: "0.0.0.0",
	clientCount: 2,
	projectCount: 0,
	sessionCount: 0,
	pinEnabled: false,
	tlsEnabled: false,
	keepAwake: false,
	keepAwakeCommand: null,
	logLevel: "info",
	supervised: true,
	projects: [],
};

/** Daemon-global feeds whose latest value the mock replays to each subscriber. */
type DaemonListTag =
	| "SubscribeInstances"
	| "SubscribeUsage"
	| "SubscribeProjects"
	| "SubscribeServerStatus";

/** Subscriptions opened once per session, so each session gets its own stream. */
const isSessionStream = (tag: string): boolean =>
	tag === "SubscribeSessionDetail" ||
	tag === "SubscribeSessionTodos" ||
	tag === "SubscribeInputDraft";

/** Live-only feeds open synchronized, with nothing to replay. */
const isLiveOnlyStream = (tag: string): boolean =>
	tag === "SubscribeAlerts" || tag === "SubscribeInputDraft";

export interface RpcMockOptions {
	readonly stubs?: StubTable;
	/** Temporary wire-shaped fixtures, migrated to stubs one domain at a time. */
	readonly handlers?: Record<string, RpcHandler>;
	readonly streams?: Record<
		string,
		(params: Record<string, unknown>) => readonly unknown[]
	>;
}

/** Mock-only catalog served by GetModels/GetAgents/GetCommands when a spec has no handler. */
export interface MockCatalog {
	instanceId?: string;
	defaultOpenCodeInstanceId?: string;
	providers?: readonly unknown[];
	agents?: ReadonlyArray<{
		providerScope: { id: string; name: string };
		agents: readonly unknown[];
	}>;
	commands?: readonly unknown[];
	/** The viewed session's model settings, as GetModels reports them. */
	active?: unknown;
	variant?: unknown;
	contextWindow?: unknown;
}

export type MockModelState = Pick<
	MockCatalog,
	"active" | "variant" | "contextWindow"
>;

export interface RecordedRpcRequest {
	readonly tag: string;
	readonly payload: Record<string, unknown>;
}

export class RpcMockControl {
	constructor(private readonly page: Page) {}
	projectSlug = "myapp";
	onConnect?: () => void;
	onSendMessage?: (payload: Record<string, unknown>) => void;
	private readonly sockets = new Set<WebSocketRoute>();
	private connectionCount = 0;
	private readonly requests: RecordedRpcRequest[] = [];
	private readonly responseHandlers = new Map<string, RpcHandler>();
	initialHandlers: Record<string, RpcHandler> = {};
	private readonly streams = new Map<
		string,
		{
			ws: WebSocketRoute;
			id: string;
			emit: (values: readonly unknown[]) => void;
			fail: (message: string) => void;
		}
	>();
	private readonly socketCleanup = new Map<WebSocketRoute, () => void>();
	shellRows: readonly unknown[] | null = null;
	familyRows: readonly unknown[] | null = null;
	private familySequence = 0;
	catalog: MockCatalog = {};
	private shellSequence = 0;
	private readonly projectSettings = new Map<string, ProjectSetting>();
	private projectSettingsSequence = 0;
	private readonly detailRows = new Map<string, readonly unknown[]>();
	private readonly detailSequences = new Map<string, number>();
	private readonly sessionTodos = new Map<string, readonly unknown[]>();
	private sessionTodosSequence = 0;

	setResponse(tag: string, value: unknown): void {
		this.responseHandlers.set(tag, () => value);
	}

	/** Answers `tag` from a handler, which may throw a WsRpcError to fail it. */
	setHandler(tag: string, handler: RpcHandler): void {
		this.responseHandlers.set(tag, handler);
	}

	stubs: StubTable = {};

	setStubs(stubs: StubTable): void {
		Object.assign(this.stubs, stubs);
	}

	getResponseHandler(tag: string): RpcHandler | undefined {
		return this.responseHandlers.get(tag) ?? this.initialHandlers[tag];
	}

	catalogHandler(tag: string): RpcHandler | undefined {
		const { providers, agents, commands, ...modelState } = this.catalog;
		const projectSlug = this.projectSlug;
		if (tag === "GetModels" && (providers || Object.keys(modelState).length))
			return ({ sessionId }) => ({
				projectSlug,
				providers: providers ?? [],
				...modelState,
				...(sessionId && modelState.instanceId === undefined
					? {
							instanceId:
								(modelState.active as { provider?: string } | undefined)
									?.provider === "claude"
									? "claude"
									: "opencode",
						}
					: {}),
			});
		if (tag === "GetCommands" && commands)
			return () => ({ projectSlug, commands });
		if (tag === "GetAgents" && agents?.length)
			return ({ instanceId }) => ({
				projectSlug,
				...(agents.find((list) => list.providerScope.id === instanceId) ??
					agents.at(-1)),
			});
		return undefined;
	}

	catalogStubs(): Required<
		Pick<StubTable, "GetModels" | "GetCommands" | "GetAgents">
	> {
		return {
			GetModels: (payload) => {
				const {
					providers,
					agents: _agents,
					commands: _commands,
					...modelState
				} = this.catalog;
				if (!providers && !Object.keys(modelState).length)
					return new Promise<never>(() => {});
				return Schema.decodeUnknownSync(GetModelsResponseSchema)({
					projectSlug: this.projectSlug,
					defaultOpenCodeInstanceId: "opencode",
					providers: providers ?? [],
					...modelState,
					...("sessionId" in payload &&
					payload.sessionId &&
					modelState.instanceId === undefined
						? {
								instanceId:
									(modelState.active as { provider?: string } | undefined)
										?.provider === "claude"
										? "claude"
										: "opencode",
							}
						: {}),
				});
			},
			GetCommands: () =>
				this.catalog.commands
					? Schema.decodeUnknownSync(GetCommandsResponseSchema)({
							projectSlug: this.projectSlug,
							commands: this.catalog.commands,
						})
					: new Promise<never>(() => {}),
			GetAgents: ({ instanceId }) =>
				this.catalog.agents?.length
					? Schema.decodeUnknownSync(GetAgentsResponseSchema)({
							projectSlug: this.projectSlug,
							...(this.catalog.agents.find(
								(list) => list.providerScope.id === instanceId,
							) ?? this.catalog.agents.at(-1)),
						})
					: new Promise<never>(() => {}),
		};
	}

	setDetailRows(sessionId: string, rows: readonly unknown[]): void {
		const sequence = (this.detailSequences.get(sessionId) ?? 0) + 1;
		this.detailRows.set(sessionId, rows);
		this.detailSequences.set(sessionId, sequence);
		if (this.streams.has(this.streamKey("SubscribeSessionDetail", sessionId)))
			this.sendChunk(
				"SubscribeSessionDetail",
				[
					{ _tag: "snapshot", rows, sequence, hasMore: false },
					{ _tag: "synchronized" },
				],
				sessionId,
			);
	}

	/** How the detail feed answers a new subscription: synchronize (default),
	 *  stall after the snapshot, hold with no frames, or fail the stream. */
	detailFeed: "synchronize" | "stall" | "hold" | "fail" = "synchronize";

	initialDetailFrames(sessionId: string): readonly unknown[] {
		if (this.detailFeed === "hold" || this.detailFeed === "fail") return [];
		const frames = [
			this.detailRows.has(sessionId)
				? {
						_tag: "snapshot",
						rows: this.detailRows.get(sessionId),
						sequence: this.detailSequences.get(sessionId) ?? 0,
						hasMore: false,
					}
				: mockDetailSnapshot(this.page, sessionId),
			{ _tag: "synchronized" },
		];
		return this.detailFeed === "stall" ? frames.slice(0, 1) : frames;
	}

	/** The relay stamps its own project on every session row it streams. */
	owned(rows: readonly unknown[]): readonly unknown[] {
		return rows.map((row) => ({
			projectSlug: this.projectSlug,
			accountId: null,
			...(row as object),
		}));
	}

	setShellRows(rows: readonly unknown[]): void {
		this.shellRows = rows;
		this.shellSequence++;
		if (this.streams.has("SubscribeShell")) {
			this.sendChunk("SubscribeShell", [
				{
					_tag: "snapshot",
					sequence: this.shellSequence,
					rows: this.owned(rows),
				},
				{ _tag: "synchronized" },
			]);
		}
	}

	/** Replace the viewed family on the open SubscribeSessionFamily stream. */
	setFamilyRows(rows: readonly unknown[]): void {
		this.familyRows = rows;
		this.familySequence++;
		if (this.streams.has("SubscribeSessionFamily"))
			this.sendChunk("SubscribeSessionFamily", this.initialFamilyFrames());
	}

	initialFamilyFrames(): readonly unknown[] {
		return this.familyRows === null
			? []
			: [
					{
						_tag: "snapshot",
						sequence: this.familySequence,
						rows: this.owned(this.familyRows),
					},
					{ _tag: "synchronized" },
				];
	}

	/** Change the model settings GetModels reports, and make the app refetch
	 *  them the way a reconnect does. */
	setModelState(state: MockModelState): void {
		this.catalog = { ...this.catalog, ...state };
		this.setShellRows(this.shellRows ?? []);
	}

	/** Change one session row the way a live write does: an upsert with no
	 *  re-snapshot, so nothing that follows `synchronized` refetches. */
	upsertShellRow(row: {
		readonly id: string;
		readonly [field: string]: unknown;
	}): void {
		const rows = this.shellRows ?? [];
		this.shellRows = [
			...rows.filter(
				(candidate) => (candidate as { id?: string }).id !== row.id,
			),
			row,
		];
		this.shellSequence++;
		if (this.streams.has("SubscribeShell"))
			this.sendChunk("SubscribeShell", [
				{
					_tag: "upsert",
					item: this.owned([row])[0],
					sequence: this.shellSequence,
				},
			]);
	}

	/** Delete one session row the way the server does: a `remove` naming it. */
	removeShellRow(id: string): void {
		this.shellRows = (this.shellRows ?? []).filter(
			(candidate) => (candidate as { id?: string }).id !== id,
		);
		this.shellSequence++;
		if (this.streams.has("SubscribeShell"))
			this.sendChunk("SubscribeShell", [
				{ _tag: "remove", id, deleted: true, sequence: this.shellSequence },
			]);
	}

	/** Publish one project-setting fact, the way another tab's or the CLI's
	 *  write reaches every open SubscribeProjectSettings stream. */
	setProjectSetting(setting: ProjectSetting): void {
		this.projectSettings.set(setting._tag, setting);
		this.projectSettingsSequence++;
		if (this.streams.has("SubscribeProjectSettings"))
			this.sendChunk("SubscribeProjectSettings", [
				{
					_tag: "upsert",
					item: setting,
					sequence: this.projectSettingsSequence,
				},
			]);
	}

	/** Publish one alert on the open SubscribeAlerts stream, as the relay does
	 *  when a session no tab is viewing finishes or fails. */
	sendAlert(alert: Alert): void {
		this.sendChunk("SubscribeAlerts", [alert]);
	}

	/** Publish a draft another tab typed on that session's SubscribeInputDraft. */
	sendInputDraft(
		sessionId: string,
		draft: { readonly text: string; readonly from?: string },
	): void {
		this.sendChunk(
			"SubscribeInputDraft",
			[{ _tag: "draft", ...draft }],
			sessionId,
		);
	}

	/** Replace one session's todo list, the way a TodoWrite does: an upsert on
	 *  that session's open SubscribeSessionTodos stream. */
	setSessionTodos(sessionId: string, items: readonly unknown[]): void {
		this.sessionTodos.set(sessionId, items);
		this.sessionTodosSequence++;
		if (this.streams.has(this.streamKey("SubscribeSessionTodos", sessionId)))
			this.sendChunk(
				"SubscribeSessionTodos",
				[
					{
						_tag: "upsert",
						item: { sessionId, items },
						sequence: this.sessionTodosSequence,
					},
				],
				sessionId,
			);
	}

	initialSessionTodosFrames(sessionId: string): readonly unknown[] {
		const items = this.sessionTodos.get(sessionId);
		return [
			{
				_tag: "snapshot",
				sequence: this.sessionTodosSequence,
				rows: items ? [{ sessionId, items }] : [],
			},
			{ _tag: "synchronized" },
		];
	}

	initialProjectSettingsFrames(): readonly unknown[] {
		return [
			{
				_tag: "snapshot",
				sequence: this.projectSettingsSequence,
				rows: [...this.projectSettings.values()],
			},
			{ _tag: "synchronized" },
		];
	}

	initialShellFrames(): readonly unknown[] {
		return this.shellRows === null
			? []
			: [
					{
						_tag: "snapshot",
						sequence: this.shellSequence,
						rows: this.owned(this.shellRows),
					},
					{ _tag: "synchronized" },
				];
	}

	/** The daemon-global lists, keyed by subscription tag; unset lists stay silent. */
	private readonly daemonLists = new Map<
		DaemonListTag,
		Record<string, unknown>
	>();

	setDaemonList(tag: DaemonListTag, value: Record<string, unknown>): void {
		this.daemonLists.set(tag, value);
		if (this.streams.has(tag)) this.sendChunk(tag, [value]);
	}

	setUsageReadings(readings: readonly UsageReading[]): void {
		this.setDaemonList("SubscribeUsage", { readings });
	}

	initialDaemonList(tag: DaemonListTag): readonly unknown[] {
		return this.daemonLists.has(tag)
			? [this.daemonLists.get(tag)]
			: tag === "SubscribeUsage"
				? [{ readings: [] }]
				: tag === "SubscribeInstances"
					? [{ instances: [] }]
					: [];
	}

	/** GetProjects answers from the mocked list, as the daemon does. */
	projectsHandler(): StubTable["GetProjects"] | undefined {
		const list = this.daemonLists.get("SubscribeProjects");
		return (
			list &&
			(() =>
				Schema.decodeUnknownSync(GetProjectsResponseSchema)({
					projectSlug: this.projectSlug,
					...list,
				}))
		);
	}

	record(tag: string, payload: Record<string, unknown>): void {
		this.requests.push({ tag, payload });
	}

	getRequests(): readonly RecordedRpcRequest[] {
		return this.requests;
	}

	/** RPC sockets opened so far, including reconnects and page reloads. */
	get connections(): number {
		return this.connectionCount;
	}

	registerSocket(ws: WebSocketRoute, cleanup: () => void): void {
		this.sockets.add(ws);
		this.socketCleanup.set(ws, cleanup);
		this.connectionCount++;
	}

	unregisterSocket(ws: WebSocketRoute): void {
		this.sockets.delete(ws);
		this.socketCleanup.get(ws)?.();
		this.socketCleanup.delete(ws);
		for (const [key, stream] of this.streams)
			if (stream.ws === ws) this.streams.delete(key);
	}

	closeSockets(options?: { code?: number; reason?: string }): void {
		for (const ws of this.sockets) {
			this.unregisterSocket(ws);
			void ws.close(options);
		}
	}

	private streamKey(tag: string, sessionId?: string): string {
		return isSessionStream(tag) ? `${tag}:${sessionId ?? ""}` : tag;
	}

	registerStream(
		tag: string,
		ws: WebSocketRoute,
		id: string,
		emit: (values: readonly unknown[]) => void,
		fail: (message: string) => void,
		sessionId?: string,
	): void {
		this.streams.set(this.streamKey(tag, sessionId), { ws, id, emit, fail });
	}

	hasStream(tag: string, sessionId?: string): boolean {
		return this.streams.has(this.streamKey(tag, sessionId));
	}

	interruptStream(requestId: string, ws?: WebSocketRoute): void {
		for (const [key, stream] of this.streams)
			if (stream.id === requestId && (!ws || stream.ws === ws))
				this.streams.delete(key);
	}

	sendChunk(tag: string, values: readonly unknown[], sessionId?: string): void {
		const stream = this.streams.get(this.streamKey(tag, sessionId));
		if (!stream) throw new Error(`No active ${tag} stream`);
		stream.emit(values);
	}

	failStream(tag: string, message: string, sessionId?: string): void {
		const key = this.streamKey(tag, sessionId);
		const stream = this.streams.get(key);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.streams.delete(key);
		stream.fail(message);
	}

	closeStreamSocket(tag: string, sessionId?: string): void {
		const key = this.streamKey(tag, sessionId);
		const stream = this.streams.get(key);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.unregisterSocket(stream.ws);
		void stream.ws.close();
	}

	async waitForRequest(
		predicate: (request: RecordedRpcRequest) => boolean,
		timeout = 5000,
	): Promise<RecordedRpcRequest> {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const match = this.requests.find(predicate);
			if (match) return match;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("Timed out waiting for RPC request");
	}
}

const isEffectRpcRequest = (value: unknown): value is EffectRpcRequest =>
	isRecord(value) &&
	value["_tag"] === "Request" &&
	typeof value["tag"] === "string" &&
	typeof value["id"] === "string";

const controls = new WeakMap<Page, RpcMockControl>();
const pendingDaemonLists = new WeakMap<
	Page,
	Map<DaemonListTag, Record<string, unknown>>
>();
const pendingShellRows = new WeakMap<Page, readonly unknown[]>();
const pendingFamilyRows = new WeakMap<Page, readonly unknown[]>();
const pendingProjectSlugs = new WeakMap<Page, string>();
const pendingCatalogs = new WeakMap<Page, MockCatalog>();
const pendingProjectSettings = new WeakMap<Page, ProjectSetting[]>();

export function setMockRpcProjectSlug(page: Page, slug: string): void {
	const control = controls.get(page);
	if (control) control.projectSlug = slug;
	else pendingProjectSlugs.set(page, slug);
}

export function setMockRpcCatalog(page: Page, catalog: MockCatalog): void {
	const control = controls.get(page);
	if (control) control.catalog = catalog;
	else pendingCatalogs.set(page, catalog);
}

export function sendMockModelState(page: Page, state: MockModelState): void {
	const control = controls.get(page);
	if (control) control.setModelState(state);
	else pendingCatalogs.set(page, { ...pendingCatalogs.get(page), ...state });
}

/** Mock-only input: deliver a daemon list through its RPC subscription. */
export function sendMockDaemonList(
	page: Page,
	tag: DaemonListTag,
	value: Record<string, unknown>,
): void {
	const control = controls.get(page);
	if (control) control.setDaemonList(tag, value);
	else
		pendingDaemonLists.set(
			page,
			new Map(pendingDaemonLists.get(page)).set(tag, value),
		);
}

/** Mock-only input: publish one project setting through its subscription. */
export function sendMockProjectSetting(
	page: Page,
	setting: ProjectSetting,
): void {
	const control = controls.get(page);
	if (control) control.setProjectSetting(setting);
	else
		pendingProjectSettings.set(page, [
			...(pendingProjectSettings.get(page) ?? []),
			setting,
		]);
}

/** Mock-only input: once the page follows `sessionId`'s draft, deliver one
 *  typed in another tab. */
export async function sendMockInputDraft(
	page: Page,
	sessionId: string,
	draft: { readonly text: string; readonly from?: string },
): Promise<void> {
	const control = controls.get(page);
	if (!control) throw new Error("mockWsRpc is not installed on this page");
	await control.waitForRequest(
		(request) =>
			request.tag === "SubscribeInputDraft" &&
			request.payload["sessionId"] === sessionId,
	);
	control.sendInputDraft(sessionId, draft);
}

export function sendMockShellSnapshot(
	page: Page,
	rows: readonly unknown[],
): void {
	const control = controls.get(page);
	if (control) control.setShellRows(rows);
	else pendingShellRows.set(page, rows);
}

/** Patch an existing session row the way a live write does (ni8.35: the
 *  shell row is the only server signal for a running turn or a goal). */
export function sendMockShellRowPatch(
	page: Page,
	sessionId: string,
	patch: (
		row: Readonly<Record<string, unknown>>,
	) => Readonly<Record<string, unknown>>,
): void {
	const control = controls.get(page);
	const rows = control?.shellRows ?? pendingShellRows.get(page) ?? [];
	const existing = rows.find(
		(row) => (row as { id?: string }).id === sessionId,
	) as Readonly<Record<string, unknown>> | undefined;
	if (!existing) return;
	const row = { ...existing, ...patch(existing), id: sessionId };
	if (control) control.upsertShellRow(row);
	else
		pendingShellRows.set(
			page,
			rows.map((candidate) => (candidate === existing ? row : candidate)),
		);
}

/** Mock-only input: deliver the viewed family through SubscribeSessionFamily. */
export function sendMockFamily(page: Page, rows: readonly unknown[]): void {
	const control = controls.get(page);
	if (control) control.setFamilyRows(rows);
	else pendingFamilyRows.set(page, rows);
}

/** Validation makes an invalid typed fixture fail its owning Playwright spec.
 * The real engine still owns every response frame and its serialization. */
function checkedReply(
	tag: string,
	schema: Schema.Schema<unknown, unknown>,
	value: unknown,
	typed: boolean,
): unknown {
	try {
		if (!typed) return Schema.decodeUnknownSync(schema)(value);
		Schema.encodeUnknownSync(schema)(value);
		return value;
	} catch (error) {
		const message = `Invalid ${typed ? "typed" : "legacy"} RPC reply for ${tag}: ${String(error)}`;
		if (typed) expect.soft(false, message).toBe(true);
		else console.warn(message);
		throw error;
	}
}

function defaultHandler(tag: string): RpcHandler | undefined {
	return (
		(tag === "GetStatus" ? () => MOCK_SERVER_STATUS : undefined) ??
		(tag === "GetDefaultGroupingMode"
			? () => ({ mode: "repository" })
			: undefined) ??
		(tag === "GetWorktreeCleanupSetting"
			? () => ({ worktreeCleanup: DEFAULT_WORKTREE_CLEANUP })
			: tag === "SetWorktreeCleanupSetting"
				? ({ worktreeCleanup }) => ({ worktreeCleanup })
				: undefined) ??
		(tag === "GetUsageLimitsSetting"
			? () => ({
					usageLimits: { autoResume: false, autoSwitch: false, order: [] },
				})
			: tag === "InspectSessionWorktrees"
				? () => ({ worktrees: [], removeWorktrees: false })
				: undefined)
	);
}

function initialStream(
	tag: string,
	payload: Record<string, unknown>,
	options: RpcMockOptions,
	control: RpcMockControl,
): readonly unknown[] {
	const stream = options.streams?.[tag];
	if (stream) return stream(payload);
	switch (tag) {
		case "SubscribeShell":
			return control.initialShellFrames();
		case "SubscribeSessionDetail":
			return control.initialDetailFrames(String(payload["sessionId"] ?? ""));
		case "SubscribeSessionTodos":
			return control.initialSessionTodosFrames(
				String(payload["sessionId"] ?? ""),
			);
		case "SubscribeSessionFamily":
			return control.initialFamilyFrames();
		case "SubscribeProjectSettings":
			return control.initialProjectSettingsFrames();
		case "SubscribeInstances":
		case "SubscribeUsage":
		case "SubscribeProjects":
		case "SubscribeServerStatus":
			return control.initialDaemonList(tag);
		default:
			return isLiveOnlyStream(tag) ? [{ _tag: "synchronized" }] : [];
	}
}

function socketTable(
	ws: WebSocketRoute,
	options: RpcMockOptions,
	control: RpcMockControl,
	requests: Map<string, EffectRpcRequest[]>,
): StubTable {
	// Iterating the group erases the tag/payload correlation checked by StubTable.
	const stubs = control.stubs as Readonly<
		Record<string, ((payload: Record<string, unknown>) => unknown) | undefined>
	>;
	const table: Record<string, (payload: never) => unknown> = {};
	for (const rpc of WsRpcGroup.requests.values()) {
		const streamSchema = RpcSchema.getStreamSchemas(rpc.successSchema.ast);
		table[rpc._tag] = (payload: Record<string, unknown>) => {
			const request = requests.get(rpc._tag)?.shift();
			if (!request) throw new Error(`Missing request for ${rpc._tag}`);
			const stub = stubs[rpc._tag];
			const override = control.getResponseHandler(rpc._tag);
			const typed = stub !== undefined && override === undefined;
			if (streamSchema._tag === "Some") {
				const schema = Schema.make(streamSchema.value.success.ast);
				// The group's stream schema establishes this result's shape.
				const source = typed
					? (stub(payload) as Stream.Stream<unknown, unknown>)
					: undefined;
				return Stream.unwrap(
					Effect.gen(function* () {
						const queue = yield* makeRpcStream<unknown, WsRpcError>();
						const sessionId = isSessionStream(rpc._tag)
							? String(payload["sessionId"] ?? "")
							: undefined;
						control.registerStream(
							rpc._tag,
							ws,
							request.id,
							(values) => Effect.runSync(queue.emit(...values)),
							(message) =>
								Effect.runSync(queue.fail(new WsRpcError({ message }))),
							sessionId,
						);
						if (source) {
							return Stream.merge(source, queue.stream, {
								haltStrategy: "left",
							});
						}
						if (rpc._tag === "SubscribeDraftModels") {
							const handler =
								control.getResponseHandler("GetModels") ??
								stubs["GetModels"] ??
								defaultHandler("GetModels");
							if (handler) {
								const response = yield* Effect.tryPromise({
									try: async () =>
										handler(payload, { ...request, tag: "GetModels" }),
									catch: (error) => new WsRpcError({ message: String(error) }),
								});
								if (!isRecord(response))
									return yield* Effect.dieMessage(
										"Mock GetModels must return an object",
									);
								yield* queue.emit({
									defaultOpenCodeInstanceId: "opencode",
									...response,
									instanceId: payload["instanceId"],
								});
							}
						} else {
							yield* queue.emit(
								...initialStream(rpc._tag, payload, options, control),
							);
						}
						if (
							rpc._tag === "SubscribeSessionDetail" &&
							control.detailFeed === "fail"
						)
							yield* queue.fail(
								new WsRpcError({ message: "detail feed unavailable" }),
							);
						return queue.stream;
					}),
				).pipe(
					Stream.map((value) => checkedReply(rpc._tag, schema, value, typed)),
					Stream.mapError((error) =>
						typed
							? checkedReply(
									rpc._tag,
									Schema.make(streamSchema.value.failure.ast),
									error,
									true,
								)
							: error,
					),
					Stream.ensuring(
						Effect.sync(() => control.interruptStream(request.id, ws)),
					),
				);
			}
			const handler = override ?? (typed ? stub : defaultHandler(rpc._tag));
			if (!handler) return new Promise<never>(() => {});
			return (async () => {
				const response = await handler(payload, request);
				const result =
					!typed && rpc._tag === "GetModels" && isRecord(response)
						? { defaultOpenCodeInstanceId: "opencode", ...response }
						: response;
				const value = checkedReply(
					rpc._tag,
					Schema.make(rpc.successSchema.ast),
					result,
					typed,
				);
				if (!rpc._tag.startsWith("Get") && isRecord(value)) {
					if (Array.isArray(value["projects"]))
						control.setDaemonList("SubscribeProjects", {
							projects: value["projects"],
						});
					if (Array.isArray(value["instances"]))
						control.setDaemonList("SubscribeInstances", {
							instances: value["instances"],
						});
				}
				return value;
			})();
		};
	}
	// Runtime iteration loses tag/payload correlation; the public stubs table retains it.
	return table as StubTable;
}

export async function mockWsRpc(
	page: Page,
	options: RpcMockOptions,
): Promise<RpcMockControl> {
	const control = controls.get(page) ?? new RpcMockControl(page);
	controls.set(page, control);
	control.initialHandlers = options.handlers ?? {};
	control.stubs = {
		"input.submit": ({ sessionId }) => ({ ok: true, sessionId }),
		GetProjects: (payload) =>
			control.projectsHandler()?.(payload) ?? new Promise<never>(() => {}),
		AttachProject: (payload) => ({
			projectSlug:
				"projectSlug" in payload && typeof payload.projectSlug === "string"
					? payload.projectSlug
					: control.projectSlug,
			sessionSlug: "sessionId" in payload ? control.projectSlug : null,
		}),
		ResolveSession: () => ({ projectSlug: control.projectSlug }),
		ViewSession: () => ({ ok: true }),
		...control.catalogStubs(),
		ResolveSessionMode: () => ({ mode: "local", source: "global" }),
		...options.stubs,
	};
	control.projectSlug = pendingProjectSlugs.get(page) ?? control.projectSlug;
	control.catalog = pendingCatalogs.get(page) ?? control.catalog;
	subscribeMockDetail(page, (sessionId, envelope) => {
		if (control.hasStream("SubscribeSessionDetail", sessionId))
			control.sendChunk("SubscribeSessionDetail", [envelope], sessionId);
	});
	const rows = pendingShellRows.get(page);
	if (rows) control.setShellRows(rows);
	const familyRows = pendingFamilyRows.get(page);
	if (familyRows) control.setFamilyRows(familyRows);
	for (const [tag, value] of pendingDaemonLists.get(page) ?? [])
		control.setDaemonList(tag, value);
	for (const setting of pendingProjectSettings.get(page) ?? [])
		control.setProjectSetting(setting);
	pendingProjectSettings.delete(page);
	await page.routeWebSocket(/\/rpc/, (ws: WebSocketRoute) => {
		const scope = Effect.runSync(Scope.make());
		const onClose = () => control.unregisterSocket(ws);
		const cleanup = () => {
			page.off("close", onClose);
			void Effect.runPromise(Scope.close(scope, Exit.void));
		};
		control.registerSocket(ws, cleanup);
		ws.onClose(onClose);
		page.once("close", onClose);
		const requests = new Map<string, EffectRpcRequest[]>();
		const submissions = new Map<string, Record<string, unknown>>();
		const ready = Effect.runPromise(
			serveRpc(socketTable(ws, options, control, requests), (json) =>
				Effect.sync(() => {
					ws.send(json);
					if (submissions.size === 0) return;
					const frame: unknown = JSON.parse(json);
					if (!isRecord(frame) || frame["_tag"] !== "Exit") return;
					const id = String(frame["requestId"]);
					const payload = submissions.get(id);
					submissions.delete(id);
					// Replay a submitted turn after its answer, as the old mock did.
					if (
						payload &&
						isRecord(frame["exit"]) &&
						frame["exit"]["_tag"] === "Success"
					)
						control.onSendMessage?.(payload);
				}),
			).pipe(Scope.extend(scope)),
		);
		control.onConnect?.();
		ws.onMessage(async (data) => {
			if (typeof data !== "string") return;
			const raw: unknown = JSON.parse(data);
			for (const frame of Array.isArray(raw) ? raw : [raw]) {
				if (isEffectRpcRequest(frame)) {
					control.record(frame.tag, frame.payload ?? {});
					if (frame.tag === "input.submit")
						submissions.set(frame.id, frame.payload ?? {});
					const pending = requests.get(frame.tag) ?? [];
					pending.push(frame);
					requests.set(frame.tag, pending);
				} else if (
					isRecord(frame) &&
					frame["_tag"] === "Interrupt" &&
					typeof frame["requestId"] === "string"
				)
					control.interruptStream(frame["requestId"], ws);
			}
			const receive = await ready;
			await Effect.runPromise(receive(data));
		});
	});
	return control;
}

/** Relay fixtures share the page's RPC mock and its replayable detail feed. */
export async function ensureMockTranscriptRpc(
	page: Page,
): Promise<RpcMockControl> {
	const control = controls.get(page);
	if (control) return control;
	return mockWsRpc(page, {
		stubs: {
			LoadMoreHistory: ({ sessionId, before }) => ({
				projectSlug: "e2e-replay",
				sessionId,
				...mockDetailPage(page, sessionId, before),
			}),
			ViewSession: () => ({ ok: true }),
			ResolveSession: () => ({
				projectSlug: "e2e-replay",
			}),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
	});
}
