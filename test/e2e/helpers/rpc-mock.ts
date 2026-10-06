import type { Page, WebSocketRoute } from "@playwright/test";
import {
	type Alert,
	type ProjectSetting,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
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

interface EffectRpcPing {
	readonly _tag: "Ping";
}

type RpcHandler = (
	params: Record<string, unknown>,
	request: JsonRpcRequest | EffectRpcRequest,
) => unknown | Promise<unknown>;

type DaemonListTag = "SubscribeInstances" | "SubscribeProjects";

/** Subscriptions opened once per session, so each session gets its own stream. */
const isSessionStream = (tag: string): boolean =>
	tag === "SubscribeSessionDetail" ||
	tag === "SubscribeSessionTodos" ||
	tag === "SubscribeInputDraft";

/** Live-only feeds open synchronized, with nothing to replay. */
const isLiveOnlyStream = (tag: string): boolean =>
	tag === "SubscribeAlerts" || tag === "SubscribeInputDraft";

export interface RpcMockOptions {
	readonly handlers: Record<string, RpcHandler>;
	readonly streams?: Record<
		string,
		(params: Record<string, unknown>) => readonly unknown[]
	>;
}

/** Mock-only catalog served by GetModels/GetAgents/GetCommands when a spec has no handler. */
export interface MockCatalog {
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
	private readonly requests: RecordedRpcRequest[] = [];
	private readonly responseHandlers = new Map<string, RpcHandler>();
	private readonly streams = new Map<
		string,
		{ ws: WebSocketRoute; id: string }
	>();
	shellRows: readonly unknown[] | null = null;
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

	getResponseHandler(tag: string): RpcHandler | undefined {
		return this.responseHandlers.get(tag);
	}

	catalogHandler(tag: string): RpcHandler | undefined {
		const { providers, agents, commands, ...modelState } = this.catalog;
		const projectSlug = this.projectSlug;
		if (tag === "GetModels" && (providers || Object.keys(modelState).length))
			return () => ({ projectSlug, providers: providers ?? [], ...modelState });
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

	setShellRows(rows: readonly unknown[]): void {
		this.shellRows = rows;
		this.shellSequence++;
		if (this.streams.has("SubscribeShell")) {
			this.sendChunk("SubscribeShell", [
				{ _tag: "snapshot", sequence: this.shellSequence, rows },
				{ _tag: "synchronized" },
			]);
		}
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
				{ _tag: "upsert", item: row, sequence: this.shellSequence },
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
						rows: this.shellRows,
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

	initialDaemonList(tag: DaemonListTag): readonly unknown[] {
		return this.daemonLists.has(tag) ? [this.daemonLists.get(tag)] : [];
	}

	/** GetProjects answers from the mocked list, as the daemon does. */
	projectsHandler(): RpcHandler | undefined {
		const list = this.daemonLists.get("SubscribeProjects");
		return list && (() => ({ projectSlug: this.projectSlug, ...list }));
	}

	record(tag: string, payload: Record<string, unknown>): void {
		this.requests.push({ tag, payload });
	}

	getRequests(): readonly RecordedRpcRequest[] {
		return this.requests;
	}

	private streamKey(tag: string, sessionId?: string): string {
		return isSessionStream(tag) ? `${tag}:${sessionId ?? ""}` : tag;
	}

	registerStream(
		tag: string,
		ws: WebSocketRoute,
		id: string,
		sessionId?: string,
	): void {
		this.streams.set(this.streamKey(tag, sessionId), { ws, id });
	}

	hasStream(tag: string, sessionId?: string): boolean {
		return this.streams.has(this.streamKey(tag, sessionId));
	}

	interruptStream(requestId: string): void {
		for (const [key, stream] of this.streams)
			if (stream.id === requestId) this.streams.delete(key);
	}

	sendChunk(tag: string, values: readonly unknown[], sessionId?: string): void {
		const stream = this.streams.get(this.streamKey(tag, sessionId));
		if (!stream) throw new Error(`No active ${tag} stream`);
		sendJson(stream.ws, { _tag: "Chunk", requestId: stream.id, values });
	}

	failStream(tag: string, message: string, sessionId?: string): void {
		const key = this.streamKey(tag, sessionId);
		const stream = this.streams.get(key);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.streams.delete(key);
		sendJson(stream.ws, {
			_tag: "Exit",
			requestId: stream.id,
			exit: {
				_tag: "Failure",
				cause: { _tag: "Fail", error: { _tag: "WsRpcError", message } },
			},
		});
	}

	closeStreamSocket(tag: string, sessionId?: string): void {
		const key = this.streamKey(tag, sessionId);
		const stream = this.streams.get(key);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.streams.delete(key);
		stream.ws.close();
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

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { method?: unknown }).method === "string";

const isEffectRpcRequest = (value: unknown): value is EffectRpcRequest =>
	typeof value === "object" &&
	value !== null &&
	(value as { _tag?: unknown })._tag === "Request" &&
	typeof (value as { tag?: unknown }).tag === "string" &&
	typeof (value as { id?: unknown }).id === "string";

const isEffectRpcPing = (value: unknown): value is EffectRpcPing =>
	typeof value === "object" &&
	value !== null &&
	(value as { _tag?: unknown })._tag === "Ping";

const isEffectRpcInterrupt = (
	value: unknown,
): value is { _tag: "Interrupt"; requestId: string } =>
	typeof value === "object" &&
	value !== null &&
	(value as { _tag?: unknown })._tag === "Interrupt" &&
	typeof (value as { requestId?: unknown }).requestId === "string";

const sendJson = (ws: WebSocketRoute, message: unknown) => {
	ws.send(JSON.stringify(message));
};

const controls = new WeakMap<Page, RpcMockControl>();
const pendingDaemonLists = new WeakMap<
	Page,
	Map<DaemonListTag, Record<string, unknown>>
>();
const pendingShellRows = new WeakMap<Page, readonly unknown[]>();
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

/** Mock-only input: deliver a daemon list through its subscription, never /ws. */
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

async function handleMessage(
	ws: WebSocketRoute,
	handlers: Record<string, RpcHandler>,
	streams: RpcMockOptions["streams"],
	control: RpcMockControl,
	raw: unknown,
) {
	if (Array.isArray(raw)) {
		for (const item of raw) {
			await handleMessage(ws, handlers, streams, control, item);
		}
		return;
	}
	if (isEffectRpcPing(raw)) {
		sendJson(ws, { _tag: "Pong" });
		return;
	}
	if (isEffectRpcInterrupt(raw)) {
		control.interruptStream(raw.requestId);
		return;
	}
	if (isEffectRpcRequest(raw)) {
		control.record(raw.tag, raw.payload ?? {});
		const daemonList =
			raw.tag === "SubscribeInstances" || raw.tag === "SubscribeProjects"
				? control.initialDaemonList(raw.tag)
				: undefined;
		const stream =
			streams?.[raw.tag] ??
			(raw.tag === "SubscribeShell" && control.initialShellFrames().length > 0
				? () => control.initialShellFrames()
				: raw.tag === "SubscribeSessionDetail"
					? (payload: Record<string, unknown>) =>
							control.initialDetailFrames(String(payload["sessionId"] ?? ""))
					: raw.tag === "SubscribeSessionTodos"
						? (payload: Record<string, unknown>) =>
								control.initialSessionTodosFrames(
									String(payload["sessionId"] ?? ""),
								)
						: raw.tag === "SubscribeProjectSettings"
							? () => control.initialProjectSettingsFrames()
							: isLiveOnlyStream(raw.tag)
								? () => [{ _tag: "synchronized" }]
								: daemonList
									? () => daemonList
									: undefined);
		if (stream) {
			const sessionId = isSessionStream(raw.tag)
				? String(raw.payload?.["sessionId"] ?? "")
				: undefined;
			control.registerStream(raw.tag, ws, raw.id, sessionId);
			const values = stream(raw.payload ?? {});
			if (values.length > 0) control.sendChunk(raw.tag, values, sessionId);
			if (raw.tag === "SubscribeSessionDetail" && control.detailFeed === "fail")
				control.failStream(raw.tag, "detail feed unavailable", sessionId);
			return;
		}
		const handler =
			control.getResponseHandler(raw.tag) ??
			handlers[raw.tag] ??
			control.catalogHandler(raw.tag) ??
			(raw.tag === "GetProjects" ? control.projectsHandler() : undefined) ??
			(raw.tag === "ResolveSession"
				? () => ({ projectSlug: control.projectSlug })
				: raw.tag === "AttachProject"
					? ({ projectSlug }) => ({
							projectSlug:
								typeof projectSlug === "string"
									? projectSlug
									: control.projectSlug,
						})
					: raw.tag === "ViewSession"
						? () => ({ ok: true })
						: undefined);
		if (!handler) return;
		try {
			const result = await handler(raw.payload ?? {}, raw);
			// A mutation's answer is the daemon's new list, which it also fans out.
			if (!raw.tag.startsWith("Get") && isRecord(result)) {
				if (Array.isArray(result["projects"]))
					control.setDaemonList("SubscribeProjects", {
						projects: result["projects"],
					});
				if (Array.isArray(result["instances"]))
					control.setDaemonList("SubscribeInstances", {
						instances: result["instances"],
					});
			}
			sendJson(ws, {
				_tag: "Exit",
				requestId: raw.id,
				exit: { _tag: "Success", value: result },
			});
		} catch (error) {
			if (error instanceof WsRpcError) {
				sendJson(ws, {
					_tag: "Exit",
					requestId: raw.id,
					exit: {
						_tag: "Failure",
						cause: {
							_tag: "Fail",
							error: { _tag: "WsRpcError", message: error.message },
						},
					},
				});
				return;
			}
			sendJson(ws, {
				_tag: "Defect",
				defect: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	if (!isJsonRpcRequest(raw)) return;

	if (raw.method === "@effect/rpc/Ping") {
		sendJson(ws, {
			jsonrpc: "2.0",
			method: "@effect/rpc/Pong",
		});
		return;
	}

	const handler =
		control.getResponseHandler(raw.method) ?? handlers[raw.method];
	if (!handler || raw.id == null) return;

	try {
		control.record(raw.method, raw.params ?? {});
		const result = await handler(raw.params ?? {}, raw);
		sendJson(ws, { jsonrpc: "2.0", id: raw.id, result });
	} catch (error) {
		sendJson(ws, {
			jsonrpc: "2.0",
			id: raw.id,
			error: {
				code: 0,
				message: error instanceof Error ? error.message : String(error),
			},
		});
	}
}

export async function mockWsRpc(
	page: Page,
	options: RpcMockOptions,
): Promise<RpcMockControl> {
	const control = controls.get(page) ?? new RpcMockControl(page);
	controls.set(page, control);
	control.projectSlug = pendingProjectSlugs.get(page) ?? control.projectSlug;
	control.catalog = pendingCatalogs.get(page) ?? control.catalog;
	subscribeMockDetail(page, (sessionId, envelope) => {
		if (control.hasStream("SubscribeSessionDetail", sessionId))
			control.sendChunk("SubscribeSessionDetail", [envelope], sessionId);
	});
	const rows = pendingShellRows.get(page);
	if (rows) control.setShellRows(rows);
	for (const [tag, value] of pendingDaemonLists.get(page) ?? [])
		control.setDaemonList(tag, value);
	for (const setting of pendingProjectSettings.get(page) ?? [])
		control.setProjectSetting(setting);
	pendingProjectSettings.delete(page);
	await page.routeWebSocket(/\/rpc/, (ws: WebSocketRoute) => {
		ws.onMessage((data) => {
			if (typeof data !== "string") return;
			try {
				void handleMessage(
					ws,
					options.handlers,
					options.streams,
					control,
					JSON.parse(data),
				);
			} catch {
				// Ignore malformed client frames in tests.
			}
		});
	});
	return control;
}

/** Legacy transcript fixtures need an RPC detail feed even when a spec only mocks /ws. */
export async function ensureMockTranscriptRpc(page: Page): Promise<void> {
	if (controls.has(page)) return;
	await mockWsRpc(page, {
		handlers: {
			ViewSession: () => ({ ok: true }),
			ResolveSession: ({ projectSlug }) => ({
				projectSlug: String(projectSlug ?? "e2e-replay"),
			}),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			LoadMoreHistory: ({ projectSlug, sessionId, before }) => ({
				projectSlug: String(projectSlug ?? "e2e-replay"),
				sessionId: String(sessionId ?? ""),
				...mockDetailPage(
					page,
					String(sessionId ?? ""),
					typeof before === "string" ? before : undefined,
				),
			}),
		},
	});
}
