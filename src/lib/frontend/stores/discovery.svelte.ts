// Agents, models, providers, and commands.

import { Effect, Either, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { untrack } from "svelte";
import { accountRefFromSelection } from "../../account-directory.js";
import type { DefaultSessionMode } from "../../contracts/project-file.js";
import {
	type BrowserDriverTraits,
	isKnownDriverKind,
	type KnownProviderDriverKind,
	PROVIDER_DRIVERS,
	type ProviderDriverKind,
	type ProviderSessionCapabilities,
} from "../../contracts/provider-instance.js";
import {
	catalogFromProviderList,
	findCatalogModel,
	offeredOptions,
	resolveTurnSettings,
} from "../../provider/turn-settings.js";
import { getIsConnected } from "../transport/connection-status.svelte.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	HarnessDefaultState,
	ProjectSetting,
	SetDefaultModelResponse,
	SetHarnessDefaultResponse,
	SetHiddenEntriesResponse,
	SwitchContextWindowResponse,
	SwitchModelResponse,
	SwitchVariantResponse,
} from "../transport/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type {
	AgentInfo,
	AgentProviderScope,
	CommandInfo,
	ContextWindowOption,
	Immutable,
	InstanceStatus,
	ModelInfo,
	ProviderGroup,
	ProviderInfo,
	SessionInfo,
	SessionPermissionMode,
} from "../types.js";
import {
	getDriverTraits,
	getInstanceTraits,
	instanceState,
} from "./instance.svelte.js";
import { getDraftProject } from "./project-state.svelte.js";
import {
	attachedProjectState,
	getCurrentSessionId,
	getCurrentSlug,
} from "./router.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { onShellSynchronized } from "./session-list.svelte.js";
import { showToast } from "./ui.svelte.js";
import { accountSnapshotChangedListeners } from "./ws-listeners.js";

export const conduitCommands = [
	{
		name: "btw",
		aliases: ["side"],
		description: "Ask in a saved Side Thread",
		handler: "startSideThread",
	},
] as const;

const cloneContextWindowOptions = (
	options:
		| readonly {
				readonly value: string;
				readonly label: string;
				readonly isDefault?: boolean | undefined;
		  }[]
		| undefined,
): ContextWindowOption[] | undefined =>
	options?.map((option) =>
		option.isDefault == null
			? { value: option.value, label: option.label }
			: {
					value: option.value,
					label: option.label,
					isDefault: option.isDefault,
				},
	);

const providersFromGetModelsResponse = (
	providers: GetModelsResponse["providers"],
): ProviderInfo[] =>
	providers.map((provider) => ({
		id: provider.id,
		...(provider.instanceId != null ? { instanceId: provider.instanceId } : {}),
		name: provider.name,
		configured: provider.configured,
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name,
			provider: model.provider,
			...(model.cost
				? {
						cost: {
							...(model.cost.input != null ? { input: model.cost.input } : {}),
							...(model.cost.output != null
								? { output: model.cost.output }
								: {}),
						},
					}
				: {}),
			...(model.limit
				? {
						limit: {
							...(model.limit.context != null
								? { context: model.limit.context }
								: {}),
							...(model.limit.output != null
								? { output: model.limit.output }
								: {}),
						},
					}
				: {}),
			...(model.variants ? { variants: [...model.variants] } : {}),
			...(model.contextWindowOptions
				? {
						contextWindowOptions:
							cloneContextWindowOptions(model.contextWindowOptions) ?? [],
					}
				: {}),
			...(model.routingOptions
				? {
						routingOptions:
							cloneContextWindowOptions(model.routingOptions) ?? [],
					}
				: {}),
		})),
	}));

// The composer's harness picker selects a provider *instance*. Default
// instances come from the daemon's isDefault flags. Catalogue groups remain
// keyed by driver; an explicit provider.instanceId keeps its own account.

export interface InstanceOption {
	readonly id: string;
	readonly driver: ProviderDriverKind;
	readonly label: string;
	/** Non-default instance of a driver — disambiguated with an accent badge. */
	readonly isCustom: boolean;
	readonly isDefault?: boolean;
	/** Newly-added instance — rendered with a sparkle in the rail. */
	readonly isNew?: boolean;
	/** Live status from the configured-instance source, when known. */
	readonly status?: InstanceStatus;
	readonly available?: boolean | undefined;
	readonly unavailableReason?: string | undefined;
	readonly unavailableCode?: "auth_required" | undefined;
	readonly capabilities?: ProviderSessionCapabilities | undefined;
}

// What the server has told us: the catalogue of providers, models, agents and
// commands, the project's defaults, and the configuration the current session
// is actually running with. Only the `handle*` and `apply*` functions in this
// module write it; `discoveryState` hands it out with no setters, so nothing
// outside can.

const missingHarnessDefaults = () =>
	Object.fromEntries(
		Object.keys(PROVIDER_DRIVERS).map((driver) => [
			driver,
			{ status: "missing" },
		]),
	) as Record<KnownProviderDriverKind, HarnessDefaultState>;

const serverDiscovery = $state({
	currentModelId: "" as string,
	currentProviderId: "" as string,
	/** Retain session-scoped metadata so a switch never uses the previous provider. */
	sessionProviderIds: {} as Record<string, string>,
	defaultModelId: "" as string,
	defaultProviderId: "" as string,
	defaultVariant: "" as string,
	defaultsLoaded: false,
	harnessDefaults: missingHarnessDefaults(),
	currentVariant: "" as string,
	availableVariants: [] as string[],
	currentContextWindow: "" as string,
	availableContextWindowOptions: [] as ReadonlyArray<ContextWindowOption>,
	permissionMode: "ask" as SessionPermissionMode,
	defaultPermissionMode: "ask" as SessionPermissionMode,
	defaultSessionMode: "local" as DefaultSessionMode,
	/** Global hide-list keys: model `<providerId>/<modelId>`. */
	hiddenModels: [] as string[],
	/** Global hide-list keys: agent `<scopeId>/<agentId>`. */
	hiddenAgents: [] as string[],
});

interface CatalogScope {
	project: string;
	sessionId: string | undefined;
	instanceId: string | undefined;
	key: string;
	commandKey: string;
}

const emptyModels = () => ({
	filledAtIssue: 0,
	providers: [] as ProviderInfo[],
	loaded: false,
	active: undefined as GetModelsResponse["active"],
	variant: undefined as GetModelsResponse["variant"],
	contextWindow: undefined as GetModelsResponse["contextWindow"],
	modelExecution: null as GetModelsResponse["modelExecution"] | null,
	permissionMode: undefined as SessionPermissionMode | undefined,
	hiddenModels: undefined as string[] | undefined,
	permissionChoice: null as {
		value: SessionPermissionMode;
		click: symbol;
	} | null,
});
const emptyAgents = () => ({
	filledAtIssue: 0,
	agents: [] as AgentInfo[],
	providerScope: null as AgentProviderScope | null,
	activeAgentId: null as string | null,
	hiddenAgents: undefined as string[] | undefined,
	choice: null as { value: string; click: symbol } | null,
});
const modelCatalogs = $state<Record<string, ReturnType<typeof emptyModels>>>(
	{},
);
const accountModelCatalogs = $state<
	Record<string, Record<string, ProviderInfo[]>>
>({});
const agentCatalogs = $state<Record<string, ReturnType<typeof emptyAgents>>>(
	{},
);
const commandCatalogs = $state<
	Record<string, { commands: CommandInfo[]; filledAtIssue: number }>
>({});
// Pruning entries must never reuse an issue number held by an in-flight read.
let catalogReadIssue = 0;
const projectCatalogDefaults = $state<Record<string, string>>({});
const noModels = emptyModels();
const noAgents = emptyAgents();

function catalogScope(
	sessionId: string | null = sessionState.currentId,
	instanceId = sessionId ? undefined : getEffectiveInstanceId(),
	project = getCurrentSlug() ?? "",
): CatalogScope {
	const key = JSON.stringify([
		project,
		sessionId ? "session" : "draft",
		sessionId ?? instanceId ?? null,
	]);
	return {
		project,
		sessionId: sessionId ?? undefined,
		instanceId,
		key,
		commandKey: JSON.stringify([
			key,
			sessionId ? (findSession(sessionId)?.workspace ?? null) : null,
		]),
	};
}

function modelsFor(scope = catalogScope()) {
	return modelCatalogs[scope.key] ?? noModels;
}
function providersFor(scope = catalogScope()): ProviderInfo[] {
	const accountId = scope.sessionId
		? getSessionInstanceId(scope.sessionId)
		: scope.instanceId;
	const discovered =
		accountModelCatalogs[scope.project]?.[accountId ?? ""] ?? [];
	const providers = [
		...modelsFor(scope).providers.filter(
			(provider) => !discovered.some((next) => next.id === provider.id),
		),
		...discovered,
	];
	return providers.some((provider) => provider.id === "claude")
		? providers.map((provider) =>
				provider.id === "anthropic"
					? { ...provider, name: "Anthropic - opencode" }
					: provider,
			)
		: providers;
}
function agentsFor(scope = catalogScope()) {
	return agentCatalogs[scope.key] ?? noAgents;
}
function draftCatalog(instanceId: string, project = getCurrentSlug() ?? "") {
	const driver = instanceState.instances.find(
		(account) => account.id === instanceId,
	)?.driver;
	return providersFor(catalogScope(null, instanceId, project)).filter(
		(provider) =>
			provider.instanceId !== undefined
				? provider.instanceId === instanceId
				: driverForProvider(provider.id) === driver,
	);
}

/** All callers refresh the currently shown scope; replies retain their issued key. */
export async function refreshCatalogs(): Promise<void> {
	const scope = catalogScope();
	if (!scope.project) return;
	await readCatalogs(scope);
}

function readCatalogs(
	scope: CatalogScope,
	catalogs: "all" | "models-agents" | "commands" = "all",
): Promise<void> {
	const issue = ++catalogReadIssue;
	const payload = scope.sessionId
		? { sessionId: scope.sessionId }
		: {
				projectSlug: scope.project,
				...(scope.instanceId ? { instanceId: scope.instanceId } : {}),
			};
	const reads: Promise<unknown>[] = [];
	if (catalogs !== "commands") {
		const applyModels = followModelsRead(scope.sessionId, scope, issue);
		reads.push(rpc("GetModels", payload).then(applyModels));
		reads.push(
			rpc("GetAgents", payload).then((response) =>
				applyGetAgentsResponse(response, scope.sessionId, scope, issue),
			),
		);
	}
	if (catalogs !== "models-agents")
		reads.push(
			rpc("GetCommands", payload).then((response) =>
				applyGetCommandsResponse(response, scope, issue),
			),
		);
	return Promise.allSettled(reads).then(() => undefined);
}

/** Mounted once by the shell. Selection will supply this scope in the next slice. */
export function watchCatalogs(): () => void {
	return $effect.root(() => {
		const modelKey = $derived(catalogScope().key);
		const commandKey = $derived(catalogScope().commandKey);
		$effect(() => {
			const key = modelKey;
			const connected = getIsConnected();
			untrack(() => {
				for (const held of Object.keys(modelCatalogs))
					if (held !== key) delete modelCatalogs[held];
				for (const held of Object.keys(agentCatalogs))
					if (held !== key) delete agentCatalogs[held];
				for (const held of Object.keys(draftModels))
					if (held !== key) delete draftModels[held];
				const scope = catalogScope();
				if (
					connected &&
					scope.project &&
					(!getCurrentSessionId() || scope.sessionId)
				)
					void readCatalogs(scope, "models-agents");
			});
		});
		$effect(() => {
			const key = commandKey;
			const connected = getIsConnected();
			untrack(() => {
				for (const held of Object.keys(commandCatalogs))
					if (held !== key) delete commandCatalogs[held];
				const scope = catalogScope();
				if (
					connected &&
					scope.project &&
					(!getCurrentSessionId() || scope.sessionId)
				)
					void readCatalogs(scope, "commands");
			});
		});
		const unsubscribe = onShellSynchronized(() => {
			void refreshCatalogs();
		});
		$effect(() => () => unsubscribe());
		$effect(() => {
			const project =
				!getCurrentSessionId() &&
				!sessionState.currentId &&
				(discoveryState.defaultsLoaded || discoveryState.hasInstanceChoice)
					? getDraftProject()
					: null;
			const instanceId = getEffectiveInstanceId();
			const ready =
				instanceState.loaded && project === attachedProjectState.slug;
			untrack(() => viewDraftModels(ready ? project : null, instanceId));
		});
		$effect(() => () => viewDraftModels(null));
	});
}

// This tab's own state. No server message writes it.
//
// `choice` is what the user has clicked but the server has not confirmed yet.
// Reads fall through to the server's value while a field is null, so a picker
// answers the click at once and the server's reply takes over the moment it
// lands. Holding the click apart from the server's value is what makes
// reverting safe: dropping our own choice cannot undo somebody else's change
// that arrived in between — the trap the old per-component
// `if (state.x === mine) state.x = previous` dance was written to dodge.

const choice = $state({
	hiddenModels: null as string[] | null,
	hiddenAgents: null as string[] | null,
	defaultModelId: null as string | null,
	defaultProviderId: null as string | null,
	defaultPermissionMode: null as SessionPermissionMode | null,
});

interface DraftPick {
	instanceId: string;
	model: {
		modelId: string;
		providerId: string;
		variant: string;
		contextWindow: string;
	};
	permissionMode: SessionPermissionMode;
}

const draft = $state<{
	instanceId: string | null;
	driver: ProviderDriverKind | null;
	permissionMode: SessionPermissionMode;
}>({ instanceId: null, driver: null, permissionMode: "ask" });
const draftModels = $state<Record<string, DraftPick["model"] | null>>({});
const draftModel = $derived(draftModels[catalogScope().key] ?? null);
let draftPermissionChosen = false;
/** Like the permission mode, an untouched draft pick follows the server default. */
let draftPickChosen = false;
const modelMemory = new Map<string, Map<string, DraftPick["model"]>>();
accountSnapshotChangedListeners.add(() => {
	const pinned = draft.instanceId;
	// A removed account, or an untouched draft's former default, falls back to its driver's default.
	if (
		pinned &&
		draft.driver !== null &&
		(!draftPickChosen ||
			!getAvailableInstances().some((account) => account.id === pinned))
	) {
		draft.instanceId = null;
		if (getEffectiveInstanceId() === pinned) draft.instanceId = pinned;
		else draftModels[catalogScope().key] = null;
	}
	fillDraftDefault();
});

export const draftModelInventory = $state({
	instanceId: null as string | null,
	loading: false,
	error: null as string | null,
});
let inventoryTarget: { projectSlug: string; instanceId: string } | null = null;
let inventoryGeneration = 0;
let inventoryFiber: RuntimeFiber<void, never> | null = null;

/** The open browser draft owns one cancellable inventory subscription. */
export function viewDraftModels(
	projectSlug: string | null,
	instanceId?: string,
	retry = false,
): void {
	if (projectSlug) fillDraftDefault();
	const target =
		projectSlug &&
		instanceId &&
		instanceState.loaded &&
		getInstanceTraits(instanceId)?.catalogSource === "server"
			? { projectSlug, instanceId }
			: null;
	if (
		inventoryTarget?.projectSlug === target?.projectSlug &&
		inventoryTarget?.instanceId === target?.instanceId &&
		(!retry || !draftModelInventory.error)
	)
		return;
	inventoryTarget = target;
	const scope = target
		? catalogScope(null, target.instanceId, target.projectSlug)
		: catalogScope(null);
	const generation = ++inventoryGeneration;
	const previous = inventoryFiber;
	inventoryFiber = null;
	draftModelInventory.instanceId = target?.instanceId ?? null;
	draftModelInventory.loading = target !== null;
	draftModelInventory.error = null;
	const fail = (message: string) => {
		if (generation !== inventoryGeneration) return;
		draftModelInventory.loading = false;
		draftModelInventory.error = message;
		modelCatalogs[scope.key] = { ...modelsFor(scope), loaded: true };
		draftModels[scope.key] = null;
		showToast(message, { variant: "error" });
	};
	void (
		previous ? runTransportEffect(Fiber.interrupt(previous)) : Promise.resolve()
	)
		.catch(() => undefined)
		.then(async () => {
			if (!target || generation !== inventoryGeneration) return;
			const runtime = await getRuntime();
			if (generation !== inventoryGeneration) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(
						clients.forProject(target.projectSlug),
						({ subscriptions }) =>
							Stream.runForEach(
								subscriptions.draftModels(target.instanceId),
								(response) =>
									Effect.sync(() => {
										if (generation !== inventoryGeneration) return;
										draftModelInventory.loading = false;
										draftModelInventory.error = null;
										// Each stream emission is a fresh inventory, independent of unary reads.
										applyGetModelsResponse(
											response,
											undefined,
											undefined,
											scope,
										);
									}),
							),
					),
				).pipe(
					Effect.catchAll((error) => Effect.sync(() => fail(error.message))),
				),
			);
			if (generation === inventoryGeneration) inventoryFiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		})
		.catch((error: unknown) =>
			fail(`OpenCode model discovery failed: ${String(error)}`),
		);
}

/** Creation copies the held draft; it does not resolve another pick. */
export function getDraftPick(): Immutable<DraftPick> | undefined {
	const instanceId = getEffectiveInstanceId();
	if (
		draftModelInventory.instanceId === instanceId &&
		(draftModelInventory.loading || draftModelInventory.error)
	)
		return undefined;
	if (!draftModel || !instanceId) return undefined;
	if (
		Either.isLeft(
			resolveTurnSettings(
				{
					harness: draftDriver(instanceId),
					model: draftModel,
					effort: draftModel.variant,
					contextWindow: draftModel.contextWindow,
				},
				catalogFromProviderList(draftCatalog(instanceId)),
			),
		)
	)
		return undefined;
	return {
		instanceId,
		model: { ...draftModel },
		permissionMode: discoveryState.permissionMode,
	};
}

interface SessionPick {
	instanceId: string;
	modelId: string;
	providerId: string;
	variant: string;
	contextWindow: string;
	variants: readonly string[];
	contextWindowOptions: readonly ContextWindowOption[];
	modelExecution: GetModelsResponse["modelExecution"] | null;
}

// A session has no pick here until its own GetModels reply arrives. Its
// confirmed value and pending clicks live together, never in draft state.
const sessionPicks = $state<
	Record<
		string,
		{
			pick: SessionPick | undefined;
			choice: {
				[Field in keyof SessionPick]?: {
					value: SessionPick[Field];
					clickId: symbol;
				};
			};
			readSeq: number;
			appliedReadSeq: number;
			ackedAtReadSeq: Partial<Record<keyof SessionPick, number>>;
		}
	>
>({});
// A project clear discards picks, but must not restart ordering for an in-flight read.
const sessionReadSequences = new Map<string, number>();

function sessionPickState(sessionId: string) {
	return (sessionPicks[sessionId] ??= {
		pick: undefined,
		choice: {},
		readSeq: sessionReadSequences.get(sessionId) ?? 0,
		appliedReadSeq: 0,
		ackedAtReadSeq: {},
	});
}

export function getSessionPick(
	sessionId: string,
): Immutable<SessionPick> | undefined {
	const state = sessionPicks[sessionId];
	if (!state?.pick) return undefined;
	const pick = { ...state.pick, instanceId: getSessionInstanceId(sessionId) };
	for (const field of Object.keys(state.choice) as (keyof SessionPick)[]) {
		const selected = state.choice[field];
		if (selected) Object.assign(pick, { [field]: selected.value });
	}
	return pick;
}

export function getSessionDriver(
	sessionId: string,
): ProviderDriverKind | undefined {
	const instanceId = getSessionInstanceId(sessionId);
	const driver = instanceState.instances.find(
		(instance) => instance.id === instanceId,
	)?.driver;
	if (driver) return driver;
	const provider =
		serverDiscovery.sessionProviderIds[sessionId] ??
		getSessionPick(sessionId)?.providerId;
	return driverForProvider(provider);
}

/** Model namespaces name local drivers; server catalogs use their owning instance. */
function driverForProvider(
	provider: string | undefined,
): ProviderDriverKind | undefined {
	if (!provider) return undefined;
	if (isKnownDriverKind(provider)) return provider;
	const instanceId = Object.values(modelCatalogs)
		.flatMap((catalog) => catalog.providers)
		.find((entry) => entry.id === provider)?.instanceId;
	return (
		instanceState.instances.find((instance) => instance.id === instanceId)
			?.driver ??
		instanceState.instances.find(
			(instance) => getDriverTraits(instance.driver)?.runsOpenCodeServer,
		)?.driver ??
		"opencode"
	);
}

/** Order reads at dispatch independently of clicks and their acknowledgements. */
export function followModelsRead(
	sessionId?: string,
	scope = catalogScope(sessionId ?? null),
	issue = ++catalogReadIssue,
): (response: GetModelsResponse) => void {
	const readSeq = untrack(() =>
		sessionId ? nextSessionRead(sessionId) : undefined,
	);
	return (response) => {
		applyGetModelsResponse(response, sessionId, readSeq, scope, issue);
	};
}

function nextSessionRead(sessionId: string): number {
	const state = sessionPickState(sessionId);
	const sequence = state.readSeq + 1;
	sessionReadSequences.set(sessionId, sequence);
	state.readSeq = sequence;
	return sequence;
}

/** Confirm replies beneath newer clicks; acknowledge only the owned overlay. */
export function followSessionPickChange(
	sessionId: string,
	click: UndoChoice,
): (patch: Partial<SessionPick>) => void {
	const state = sessionPicks[sessionId];
	const clickId = click.clickId;
	return (patch) => {
		if (!state?.pick || !clickId || sessionPicks[sessionId] !== state) return;
		for (const field of Object.keys(patch) as (keyof SessionPick)[]) {
			Object.assign(state.pick, { [field]: patch[field] });
			state.ackedAtReadSeq[field] = state.readSeq;
		}
		for (const field of Object.keys(state.choice) as (keyof SessionPick)[]) {
			if (state.choice[field]?.clickId === clickId) delete state.choice[field];
		}
	};
}

function refreshSessionPick(sessionId: string): void {
	const apply = followModelsRead(sessionId);
	void rpc("GetModels", { sessionId })
		.then(apply)
		.catch(() => undefined);
}

function chooseSessionPick(
	sessionId: string,
	patch: Partial<SessionPick>,
): UndoChoice {
	const state = sessionPicks[sessionId];
	if (!state?.pick) return () => {};
	const clickId = Symbol();
	const fields = Object.keys(patch) as (keyof SessionPick)[];
	for (const field of fields) {
		Object.assign(state.choice, {
			[field]: { value: patch[field], clickId },
		});
	}
	return Object.assign(
		() => {
			if (sessionPicks[sessionId] !== state) return;
			for (const field of fields) {
				if (state.choice[field]?.clickId === clickId)
					delete state.choice[field];
			}
			refreshSessionPick(sessionId);
		},
		{ clickId },
	);
}

/** Read view over both halves. Server-owned fields have no setter: write them
 *  by applying a wire message or an RPC response. Fields the user can pick
 *  ahead of the server read through `choice` first — see the `choose*`
 *  actions. */
export const discoveryState = {
	get currentDriver(): ProviderDriverKind | undefined {
		return sessionState.currentId
			? getSessionDriver(sessionState.currentId)
			: (getAvailableInstances().find(
					(instance) => instance.id === getEffectiveInstanceId(),
				)?.driver ??
					draft.driver ??
					driverForProvider(this.currentProviderId || this.defaultProviderId));
	},
	get currentTraits(): BrowserDriverTraits | undefined {
		return this.currentProviderId
			? getDriverTraits(this.currentDriver)
			: undefined;
	},
	// Server-owned.
	get agents(): readonly Immutable<AgentInfo>[] {
		return agentsFor().agents;
	},
	get agentProviderScope(): Immutable<AgentProviderScope> | null {
		return agentsFor().providerScope;
	},
	get activeAgentId(): string | null {
		const entry = agentsFor();
		return entry.choice?.value ?? entry.activeAgentId;
	},
	get providers(): readonly Immutable<ProviderInfo>[] {
		return providersFor();
	},
	get sessionProviderIds(): Readonly<Record<string, string>> {
		return serverDiscovery.sessionProviderIds;
	},
	get commands(): readonly Immutable<CommandInfo>[] {
		return commandCatalogs[catalogScope().commandKey]?.commands ?? [];
	},
	get commandsFetched(): boolean {
		return commandCatalogs[catalogScope().commandKey] !== undefined;
	},
	get modelsLoaded(): boolean {
		const scope = catalogScope();
		const accountId = scope.sessionId
			? getSessionInstanceId(scope.sessionId)
			: scope.instanceId;
		return (
			modelsFor(scope).loaded ||
			accountModelCatalogs[scope.project]?.[accountId ?? ""] !== undefined
		);
	},
	get defaultVariant(): string {
		return serverDiscovery.defaultVariant;
	},
	get harnessDefaults(): Readonly<
		Record<KnownProviderDriverKind, HarnessDefaultState>
	> {
		return serverDiscovery.harnessDefaults;
	},
	get availableVariants(): readonly string[] {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.variants ?? [];
		return getActiveModel()?.variants ?? [];
	},
	get availableContextWindowOptions(): readonly Immutable<ContextWindowOption>[] {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.contextWindowOptions ?? [];
		return getActiveModel()?.contextWindowOptions ?? [];
	},
	get modelExecution(): Immutable<GetModelsResponse["modelExecution"]> | null {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.modelExecution ?? null;
		return modelsFor().modelExecution;
	},

	// Server-owned, with this tab's unconfirmed click read first.
	get hasInstanceChoice(): boolean {
		return draft.instanceId !== null;
	},
	get defaultsLoaded(): boolean {
		return serverDiscovery.defaultsLoaded;
	},
	get hasModelChoice(): boolean {
		if (sessionState.currentId) return false;
		return draftModel !== null;
	},
	get currentModelId(): string {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.modelId ?? "";
		return draftModel?.modelId ?? "";
	},
	get currentProviderId(): string {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.providerId ?? "";
		return draftModel?.providerId ?? "";
	},
	get currentVariant(): string {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.variant ?? "";
		return draftModel?.variant ?? "";
	},
	get currentContextWindow(): string {
		if (sessionState.currentId)
			return getSessionPick(sessionState.currentId)?.contextWindow ?? "";
		return draftModel?.contextWindow ?? "";
	},
	get permissionMode(): SessionPermissionMode {
		return sessionState.currentId
			? (modelsFor().permissionChoice?.value ??
					modelsFor().permissionMode ??
					serverDiscovery.permissionMode)
			: draftPermissionChosen
				? draft.permissionMode
				: (modelsFor().permissionMode ?? draft.permissionMode);
	},
	get defaultModelId(): string {
		return choice.defaultModelId ?? serverDiscovery.defaultModelId;
	},
	get defaultProviderId(): string {
		return choice.defaultProviderId ?? serverDiscovery.defaultProviderId;
	},
	get defaultPermissionMode(): SessionPermissionMode {
		return (
			choice.defaultPermissionMode ?? serverDiscovery.defaultPermissionMode
		);
	},
	get defaultSessionMode(): DefaultSessionMode {
		return serverDiscovery.defaultSessionMode;
	},
	get hiddenModels(): readonly string[] {
		return (
			choice.hiddenModels ??
			modelsFor().hiddenModels ??
			serverDiscovery.hiddenModels
		);
	},
	get hiddenAgents(): readonly string[] {
		return (
			choice.hiddenAgents ??
			agentsFor().hiddenAgents ??
			serverDiscovery.hiddenAgents
		);
	},
};

// Components should wrap in $derived() for reactive caching.

/** Get the currently active agent. */
export function getActiveAgent(): Immutable<AgentInfo> | undefined {
	return discoveryState.agents.find(
		(a) => a.id === discoveryState.activeAgentId,
	);
}

/** Get all models from all providers, flattened. */
export function getAllModels(): readonly Immutable<ModelInfo>[] {
	return discoveryState.providers.flatMap((p) => p.models);
}

/** Get the currently active model. Grouped models (Bedrock geo routing)
 *  match when the active id is any of their routing option values. */
export function getActiveModel(
	currentId = discoveryState.currentModelId,
	providerId = discoveryState.currentProviderId,
): Immutable<ModelInfo> | undefined {
	const instanceId = sessionState.currentId
		? getSessionInstanceId(sessionState.currentId)
		: getEffectiveInstanceId();
	const providers = sessionState.currentId
		? discoveryState.providers
		: instanceId
			? draftCatalog(instanceId)
			: [];
	return providers
		.find((provider) => provider.id === providerId)
		?.models.find((model) => modelMatchesId(model, currentId));
}

/** Whether `modelId` names this catalog entry. A trailing `[1m]` is Claude's
 *  request-side context-window marker, not identity: turns persist the API
 *  form ("opus[1m]") and a reopened session restores it, while the catalog may
 *  advertise the bare alias ("opus") or the suffixed form. */
export function modelMatchesId(
	model: Immutable<ModelInfo>,
	modelId: string | null | undefined,
): boolean {
	if (!modelId) return false;
	const identity = (id: string) => id.replace(/\[1m\]$/i, "");
	return (
		identity(model.id) === identity(modelId) ||
		!!model.routingOptions?.some((option) => option.value === modelId)
	);
}

/** Get models grouped by provider for dropdown rendering. */
export function getProviderGroups(): readonly Immutable<ProviderGroup>[] {
	return discoveryState.providers
		.filter((p) => p.models.length > 0)
		.map((p) => ({ provider: p, models: p.models }));
}

/** Project defaults use each driver's default account, independently of the open session. */
export function getHarnessDefaultProviders(
	harness: KnownProviderDriverKind,
): readonly Immutable<ProviderInfo>[] {
	if (getDriverTraits(harness)?.catalogSource === "discovery") {
		const account = getAvailableInstances().find(
			(instance) => instance.driver === harness && instance.isDefault,
		);
		return account
			? (accountModelCatalogs[catalogScope().project]?.[account.id] ?? [])
			: [];
	}
	return discoveryState.providers.filter(
		(provider) => driverForProvider(provider.id) === harness,
	);
}

/** Agents visible in the dropdown after applying the global hide-list.
 *  Never-brick: if filtering would leave zero agents, show all. */
export function getVisibleAgents(): readonly Immutable<AgentInfo>[] {
	const scopeId = discoveryState.agentProviderScope?.id;
	if (!scopeId || discoveryState.hiddenAgents.length === 0) {
		return discoveryState.agents;
	}
	const hidden = new Set(discoveryState.hiddenAgents);
	const visible = discoveryState.agents.filter(
		(a) => !hidden.has(`${scopeId}/${a.id}`),
	);
	return visible.length > 0 ? visible : discoveryState.agents;
}

/** Provider groups visible in the dropdown after applying the global hide-list.
 *  Groups with zero visible models are dropped.
 *  Never-brick: if filtering would leave zero models overall, show all. */
export function getVisibleProviderGroups(): readonly Immutable<ProviderGroup>[] {
	const all = getProviderGroups();
	if (discoveryState.hiddenModels.length === 0) return all;
	const hidden = new Set(discoveryState.hiddenModels);
	const filtered = all
		.map((g) => ({
			provider: g.provider,
			models: g.models.filter((m) => !hidden.has(`${g.provider.id}/${m.id}`)),
		}))
		.filter((g) => g.models.length > 0);
	return filtered.length > 0 ? filtered : all;
}

/** Configured accounts are authoritative, including before models arrive.
 *  Driver defaults sort first (Claude, then OpenCode), ordinary accounts after. */
export function getAvailableInstances(): InstanceOption[] {
	const available = instanceState.instances.map((inst): InstanceOption => {
		const driver = inst.driver ?? "opencode";
		return {
			id: inst.id,
			driver,
			label: inst.name || inst.id,
			isDefault: inst.isDefault ?? false,
			isCustom: !inst.isDefault,
			status: inst.status,
			available: inst.available,
			unavailableReason: inst.unavailableReason,
			unavailableCode: inst.unavailableCode,
			capabilities:
				inst.capabilities ??
				instanceState.providerCapabilities[driver] ??
				getDriverTraits(driver)?.sessionCapabilities,
		};
	});
	const rank = (i: InstanceOption) => {
		if (
			i.isDefault &&
			getDriverTraits(i.driver)?.accountKind === "config-directory"
		)
			return 0;
		if (i.isDefault && getDriverTraits(i.driver)?.runsOpenCodeServer) return 1;
		return 2;
	};
	return available.sort(
		(a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
	);
}

/** Visible provider groups scoped to one instance (the picker's right pane). */
export function getProviderGroupsForInstance(
	instanceId: string | null | undefined,
): readonly Immutable<ProviderGroup>[] {
	if (!instanceId) return [];
	const driver = instanceState.instances.find(
		(instance) => instance.id === instanceId,
	)?.driver;
	if (!driver) return [];
	const cached = !sessionState.currentId && draftCatalog(instanceId);
	if (cached) {
		const groups = cached.map((provider) => ({
			provider,
			models: provider.models,
		}));
		const hidden = new Set(discoveryState.hiddenModels);
		const visible = groups
			.map((group) => ({
				...group,
				models: group.models.filter(
					(model) => !hidden.has(`${group.provider.id}/${model.id}`),
				),
			}))
			.filter((group) => group.models.length > 0);
		return visible.length
			? visible
			: groups.filter((group) => group.models.length > 0);
	}
	if (!sessionState.currentId) return [];
	return getVisibleProviderGroups().filter((g) =>
		g.provider.instanceId !== undefined
			? g.provider.instanceId === instanceId
			: driverForProvider(g.provider.id) === driver,
	);
}

/** Hold a live draft account; removed accounts fall back to their driver's default. */
export function getEffectiveInstanceId(): string | undefined {
	const available = getAvailableInstances();
	if (draft.instanceId !== null)
		return available.find((account) => account.id === draft.instanceId)?.id;
	const provider = discoveryState.defaultProviderId;
	const driver = draft.driver ?? driverForProvider(provider);
	const defaultOpenCodeInstanceId =
		projectCatalogDefaults[getCurrentSlug() ?? ""];
	if (
		getDriverTraits(driver)?.runsOpenCodeServer &&
		defaultOpenCodeInstanceId &&
		available.some(
			(account) =>
				account.id === defaultOpenCodeInstanceId && account.driver === driver,
		)
	)
		return defaultOpenCodeInstanceId;
	return available.find(
		(account) =>
			account.isDefault && (driver === undefined || account.driver === driver),
	)?.id;
}

/** The server's session snapshot publishes the directory's effective account. */
export function getSessionInstanceId(sessionId: string): string {
	return findSession(sessionId)?.accountId ?? "";
}

function draftDriver(instanceId: string | undefined): KnownProviderDriverKind {
	const driver = instanceState.instances.find(
		(instance) => instance.id === instanceId,
	)?.driver;
	return isKnownDriverKind(driver) ? driver : "opencode";
}

/** Fill only an empty draft from the selected harness's resolved default. */
function fillDraftDefault(): void {
	if (
		!serverDiscovery.defaultsLoaded ||
		(!instanceState.loaded && draft.instanceId === null) ||
		sessionState.currentId ||
		draftModel
	)
		return;
	const instanceId = getEffectiveInstanceId();
	if (!instanceId) return;
	const defaults = serverDiscovery.harnessDefaults[draftDriver(instanceId)];
	if (
		draft.instanceId === null &&
		getInstanceTraits(instanceId)?.runsOpenCodeServer &&
		projectCatalogDefaults[getCurrentSlug() ?? ""] === undefined
	)
		return;
	if (defaults.status !== "ok" || !defaults.pick) return;
	const catalog = catalogFromProviderList(draftCatalog(instanceId));
	const resolved = resolveTurnSettings(
		{
			harness: draftDriver(instanceId),
			model: defaults.pick,
			effort: defaults.pick.effort,
			contextWindow: defaults.pick.contextWindow,
		},
		catalog,
	);
	if (Either.isLeft(resolved)) return;
	if (!draftPermissionChosen)
		draft.permissionMode = serverDiscovery.defaultPermissionMode;
	setDraftModel(
		defaults.pick,
		defaults.pick.effort,
		defaults.pick.contextWindow,
	);
}

function rememberDraftModel(scope?: CatalogScope): void {
	const target = scope ?? catalogScope();
	const model = draftModels[target.key];
	if (!target.instanceId || !model) return;
	if (!scope) {
		draft.instanceId = target.instanceId;
		draft.driver = draftDriver(target.instanceId);
	}
	let models = modelMemory.get(target.instanceId);
	if (!models) modelMemory.set(target.instanceId, (models = new Map()));
	models.set(`${model.providerId}/${model.modelId}`, {
		...model,
	});
}

function setDraftModel(
	model: { modelId: string; providerId: string },
	effort?: string,
	contextWindow?: string,
	scope?: CatalogScope,
): void {
	const target = scope ?? catalogScope(null);
	const instanceId = target.instanceId;
	if (!instanceId) return;
	if (
		draftModelInventory.instanceId === instanceId &&
		draftModelInventory.error
	)
		return;
	const harness = draftDriver(instanceId);
	const catalog = catalogFromProviderList(
		draftCatalog(instanceId, target.project),
	);
	const entry = findCatalogModel(harness, model, catalog);
	if (!entry) return;
	const options = offeredOptions(entry);
	const remembered = modelMemory
		.get(instanceId)
		?.get(`${model.providerId}/${model.modelId}`);
	const variant = effort ?? remembered?.variant ?? "";
	const selectedWindow = contextWindow ?? remembered?.contextWindow ?? "";
	const resolved = resolveTurnSettings(
		{
			harness,
			model,
			effort: options.efforts.includes(variant) ? variant : "",
			contextWindow: options.contextWindows.some(
				(option) => option.value === selectedWindow,
			)
				? selectedWindow
				: (options.contextWindows.find((option) => option.isDefault)?.value ??
					""),
		},
		catalog,
	);
	if (Either.isLeft(resolved)) return;
	if (!scope) {
		draft.instanceId = instanceId;
		draft.driver = harness;
	}
	draftModels[target.key] = {
		...resolved.right.model,
		variant: resolved.right.effort,
		contextWindow: resolved.right.contextWindow,
	};
	// Prefilling a harness default must not erase this model's browser memory.
	if ((effort === undefined && contextWindow === undefined) || !remembered)
		rememberDraftModel(target);
}

/** A different instance starts with its own default, never a neighboring model. */
export function selectInstance(instanceId: string): void {
	draftPickChosen = true;
	const available = getAvailableInstances();
	const ref = accountRefFromSelection({ providerId: instanceId });
	const selected =
		available.find((account) => account.id === instanceId) ??
		(ref._tag === "DriverDefault"
			? available.find(
					(account) => account.driver === ref.driver && account.isDefault,
				)
			: undefined);
	if (!selected) {
		draft.instanceId = ref._tag === "Id" ? instanceId : null;
		draft.driver = ref._tag === "DriverDefault" ? ref.driver : null;
		draftModels[catalogScope().key] = null;
		return;
	}
	if (draft.instanceId === selected.id) return;
	draft.instanceId = selected.id;
	draft.driver = selected.driver;
	draftModels[catalogScope().key] = null;
	if (
		!getDriverTraits(selected.driver)?.permissionModes.includes(
			draft.permissionMode,
		)
	)
		draft.permissionMode = "ask";
	fillDraftDefault();
}

/** A created or viewed session consumes the draft's harness and model picks. */
export function clearDraftSelection(): void {
	for (const key of Object.keys(draftModels)) delete draftModels[key];
	draft.instanceId = null;
	draft.driver = null;
	draft.permissionMode = serverDiscovery.defaultPermissionMode;
	draftPermissionChosen = false;
	draftPickChosen = false;
}

/** Format agent label for display. */
export function formatAgentLabel(agent: Immutable<AgentInfo>): string {
	return agent.name || agent.id;
}

/** Build tooltip text for an agent. */
export function buildAgentTooltip(agent: Immutable<AgentInfo>): string {
	return agent.description || agent.name || agent.id;
}

/** Format model name for display. */
export function formatModelName(model: Immutable<ModelInfo>): string {
	return model.name || model.id;
}

export function getModelDisplayName(modelId: string): string {
	const model = getAllModels().find((candidate) =>
		modelMatchesId(candidate, modelId),
	);
	return model ? formatModelName(model) : modelId;
}

/** Check if a provider is configured. */
export function isProviderConfigured(
	provider: Immutable<ProviderInfo>,
): boolean {
	return provider.configured;
}

/** Filter commands by query (case-insensitive prefix match on name). */
export function filterCommands(
	commands: readonly Immutable<CommandInfo>[],
	query: string,
): readonly Immutable<CommandInfo>[] {
	if (!query) return commands;
	const lower = query.toLowerCase();
	return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

export interface CommandQuery {
	/** `$` opens the provider's built-ins, `/` the user's skills and commands. */
	trigger: "/" | "$";
	query: string;
	start: number;
	end: number;
}

/** Extract a `/skill` or `$builtin` query from input text at cursor position. */
export function extractCommandQuery(
	text: string,
	cursorPos: number,
): CommandQuery | null {
	// Look backwards from cursor for a trigger at the start of the line or after whitespace
	const before = text.slice(0, cursorPos);
	const match = before.match(/(?:^|\s)([/$])(\S*)$/);
	if (!match) return null;

	const trigger = match[1] === "$" ? "$" : "/";
	const query = match[2] ?? "";
	const start = before.length - query.length - 1;

	return { trigger, query, start, end: cursorPos };
}

/**
 * Providers only understand `/name`, so rewrite each `$builtin` in command
 * position before sending. Unknown `$tokens` (prices, shell vars) pass through.
 */
export function toProviderCommands(
	text: string,
	builtinNames: ReadonlySet<string>,
): string {
	return text.replace(
		/(^|\s)\$([A-Za-z0-9][A-Za-z0-9_:-]*)(?![\w:/-])/g,
		(token, lead: string, name: string) =>
			builtinNames.has(name) ? `${lead}/${name}` : token,
	);
}

export function handleAgentList(
	{
		agents,
		activeAgentId,
		providerScope,
	}: {
		readonly agents: readonly AgentInfo[];
		readonly providerScope: AgentProviderScope;
		readonly activeAgentId?: string;
	},
	scope = catalogScope(),
	issue = ++catalogReadIssue,
): void {
	agentCatalogs[scope.key] = {
		...agentsFor(scope),
		filledAtIssue: issue,
		agents: [...agents],
		providerScope,
		activeAgentId: activeAgentId ?? null,
		choice: null,
	};
}

export function applyGetAgentsResponse(
	response: GetAgentsResponse,
	sessionId?: string,
	scope = catalogScope(sessionId ?? null),
	issue = ++catalogReadIssue,
): void {
	if (issue < agentsFor(scope).filledAtIssue) return;
	handleAgentList(
		{
			providerScope: response.providerScope,
			agents: response.agents.map((agent) => ({
				id: agent.id,
				name: agent.name,
				...(agent.description != null
					? { description: agent.description }
					: {}),
				...(agent.model != null ? { model: agent.model } : {}),
			})),
			...(response.activeAgentId != null
				? { activeAgentId: response.activeAgentId }
				: {}),
		},
		scope,
		issue,
	);
	if (sessionId) {
		serverDiscovery.sessionProviderIds[sessionId] = response.providerScope.id;
	}
	if (response.hiddenAgents) {
		const entry = agentCatalogs[scope.key];
		if (entry) entry.hiddenAgents = [...response.hiddenAgents];
	}
}

export function handleModelList(
	{
		providers,
		accountId,
	}: {
		readonly providers: GetModelsResponse["providers"];
		readonly accountId?: string | undefined;
	},
	project = getCurrentSlug() ?? "",
): void {
	const scope = catalogScope(sessionState.currentId, undefined, project);
	const catalog = providersFromGetModelsResponse(providers);
	const catalogAccountId =
		accountId ??
		getAvailableInstances().find(
			(account) =>
				account.isDefault &&
				getDriverTraits(account.driver)?.catalogSource === "discovery" &&
				catalog.some((provider) => provider.id === account.driver),
		)?.id;
	if (catalogAccountId) {
		(accountModelCatalogs[project] ??= {})[catalogAccountId] = catalog.filter(
			(provider) => getDriverTraits(provider.id)?.catalogSource === "discovery",
		);
	}
	const scopedProviders = catalogAccountId
		? catalog.filter(
				(provider) =>
					getDriverTraits(provider.id)?.catalogSource !== "discovery",
			)
		: catalog;
	if (scopedProviders.length || !catalogAccountId) {
		modelCatalogs[scope.key] = {
			...modelsFor(scope),
			providers: scopedProviders,
			loaded: true,
		};
	}
	if (draftModel) {
		const selected = draftModel;
		draftModels[catalogScope().key] = null;
		setDraftModel(selected, selected.variant, selected.contextWindow);
	}
	fillDraftDefault();
}

export function applyGetModelsResponse(
	response: GetModelsResponse,
	sessionId?: string,
	readSeq?: number,
	scope = catalogScope(
		sessionId ?? null,
		sessionId ? undefined : (response.instanceId ?? getEffectiveInstanceId()),
	),
	issue = ++catalogReadIssue,
): void {
	if (issue < modelsFor(scope).filledAtIssue) return;
	if (sessionId) {
		const state = sessionPickState(sessionId);
		const seq = readSeq ?? nextSessionRead(sessionId);
		if (seq <= state.appliedReadSeq) return;
		state.appliedReadSeq = seq;
		const pick: SessionPick = {
			instanceId: response.instanceId ?? "",
			modelId: response.active?.model ?? "",
			providerId: response.active?.provider ?? "",
			variant: response.variant?.variant ?? "",
			contextWindow: response.contextWindow?.contextWindow ?? "",
			variants: [...(response.variant?.variants ?? [])],
			contextWindowOptions:
				cloneContextWindowOptions(response.contextWindow?.options) ?? [],
			modelExecution: response.modelExecution
				? { ...response.modelExecution }
				: null,
		};
		if (!state.pick) state.pick = pick;
		else {
			for (const field of Object.keys(pick) as (keyof SessionPick)[]) {
				if (seq > (state.ackedAtReadSeq[field] ?? 0)) {
					Object.assign(state.pick, { [field]: pick[field] });
				}
			}
		}
	}
	if (response.defaultOpenCodeInstanceId !== undefined)
		projectCatalogDefaults[scope.project] = response.defaultOpenCodeInstanceId;
	const previous = modelsFor(scope);
	modelCatalogs[scope.key] = {
		...previous,
		filledAtIssue: issue,
		providers: providersFromGetModelsResponse(response.providers),
		loaded: true,
		active: response.active,
		variant: response.variant,
		contextWindow: response.contextWindow,
		modelExecution: response.modelExecution
			? { ...response.modelExecution }
			: null,
		permissionMode: response.permissionMode ?? previous.permissionMode,
		permissionChoice: response.permissionMode
			? null
			: previous.permissionChoice,
		hiddenModels: response.hiddenModels
			? [...response.hiddenModels]
			: previous.hiddenModels,
	};
	// A fresh account reply can supply its own native default. Never refill from a cached active pick.
	if (
		!scope.sessionId &&
		scope.instanceId &&
		response.active &&
		!draftModels[scope.key]
	) {
		setDraftModel(
			{ modelId: response.active.model, providerId: response.active.provider },
			response.variant?.variant ?? "",
			response.contextWindow?.contextWindow ?? "",
			scope,
		);
	}
	fillDraftDefault();
}

export function handleModelInfo(msg: {
	readonly model: string;
	readonly provider: string;
}): void {
	const { model, provider } = msg;
	if (model) serverDiscovery.currentModelId = model;
	if (provider) serverDiscovery.currentProviderId = provider;
}

export function handleCommandList(
	{
		commands,
	}: {
		readonly commands: readonly CommandInfo[];
	},
	scope = catalogScope(),
	issue = ++catalogReadIssue,
): void {
	commandCatalogs[scope.commandKey] = {
		commands: [...commands],
		filledAtIssue: issue,
	};
}

export function applyGetCommandsResponse(
	response: GetCommandsResponse,
	scope = catalogScope(),
	issue = ++catalogReadIssue,
): void {
	if (issue < (commandCatalogs[scope.commandKey]?.filledAtIssue ?? 0)) return;
	handleCommandList(
		{
			commands: response.commands.map((command) => ({
				name: command.name,
				...(command.description != null
					? { description: command.description }
					: {}),
				...(command.args != null ? { args: command.args } : {}),
				...(command.builtin ? { builtin: true } : {}),
			})),
		},
		scope,
		issue,
	);
}

export function handleDefaultModelInfo(msg: {
	readonly model?: string | undefined;
	readonly provider?: string | undefined;
	readonly variant?: string | undefined;
}): void {
	if (
		!draftPickChosen &&
		((msg.model ?? "") !== serverDiscovery.defaultModelId ||
			(msg.provider ?? "") !== serverDiscovery.defaultProviderId)
	) {
		draft.instanceId = null;
		draft.driver = null;
		draftModels[catalogScope().key] = null;
	}
	serverDiscovery.defaultModelId = msg.model ?? "";
	serverDiscovery.defaultProviderId = msg.provider ?? "";
	serverDiscovery.defaultVariant = msg.variant ?? "";
	serverDiscovery.defaultsLoaded = true;
	choice.defaultModelId = null;
	choice.defaultProviderId = null;
	fillDraftDefault();
}

export function handleHarnessDefaults(
	setting: Extract<ProjectSetting, { _tag: "harnessDefaults" }>,
): void {
	const { _tag, ...defaults } = setting;
	serverDiscovery.harnessDefaults = {
		...missingHarnessDefaults(),
		...defaults,
	};
	fillDraftDefault();
}

export function applyHarnessDefaultSet(
	response: SetHarnessDefaultResponse,
): void {
	serverDiscovery.harnessDefaults[response.harness] = response.state;
	fillDraftDefault();
}

/** Get the available variants for the currently active model. */
export function getActiveModelVariants(): readonly string[] {
	if (sessionState.currentId) return discoveryState.availableVariants;
	return getActiveModel()?.variants ?? [];
}

/** Get the available context-window options for the currently active model.
 *  Prefer the selected model's own options so the dropdown appears the moment a
 *  supporting model is picked, without waiting for a server round-trip; fall
 *  back to the last server-provided list otherwise. */
export function getActiveContextWindowOptions(): readonly Immutable<ContextWindowOption>[] {
	if (sessionState.currentId)
		return discoveryState.availableContextWindowOptions;
	return getActiveModel()?.contextWindowOptions ?? [];
}

export function handleVariantInfo(msg: {
	readonly variant?: string;
	readonly variants?: readonly string[];
}): void {
	serverDiscovery.currentVariant = msg.variant ?? "";
	serverDiscovery.availableVariants = [...(msg.variants ?? [])];
}

export function handleContextWindowInfo(msg: {
	readonly contextWindow: string;
	readonly options: readonly ContextWindowOption[];
}): void {
	serverDiscovery.currentContextWindow = msg.contextWindow ?? "";
	serverDiscovery.availableContextWindowOptions = msg.options ?? [];
}

type SessionModelSettings = Pick<
	SessionInfo,
	"model" | "variant" | "contextWindow" | "resumes" | "accountId"
>;

/** Rows invalidate a read; they never hydrate a session's displayed pick. */
export function followSessionModelSettings(
	row: SessionModelSettings,
	previous: SessionModelSettings | undefined,
): void {
	if (!previous) return;
	if (
		row.model?.model === previous.model?.model &&
		row.model?.provider === previous.model?.provider &&
		row.variant === previous.variant &&
		row.contextWindow === previous.contextWindow &&
		row.accountId === previous.accountId &&
		row.resumes?.at(-1)?.instanceId === previous.resumes?.at(-1)?.instanceId
	)
		return;
	const sessionId = sessionState.currentId;
	if (!sessionId) return;
	refreshSessionPick(sessionId);
}

export function handlePermissionModeInfo(msg: {
	readonly mode: SessionPermissionMode;
}): void {
	serverDiscovery.permissionMode = msg.mode;
	const scope = catalogScope();
	modelCatalogs[scope.key] = {
		...modelsFor(scope),
		permissionMode: msg.mode,
		permissionChoice: null,
	};
}

export function handleVisibilityInfo(msg: {
	readonly hiddenModels: readonly string[];
	readonly hiddenAgents: readonly string[];
}): void {
	serverDiscovery.hiddenModels = [...msg.hiddenModels];
	serverDiscovery.hiddenAgents = [...msg.hiddenAgents];
	const scope = catalogScope();
	modelCatalogs[scope.key] = {
		...modelsFor(scope),
		hiddenModels: [...msg.hiddenModels],
	};
	agentCatalogs[scope.key] = {
		...agentsFor(scope),
		hiddenAgents: [...msg.hiddenAgents],
	};
	choice.hiddenModels = null;
	choice.hiddenAgents = null;
}

// A picker writes the user's click here, sends the RPC, and applies the
// response. Each `choose*` hands back the undo for *that* click; call it when
// the server refuses. No component keeps a `previous…` variable any more: the
// server's value was never overwritten, so there is nothing to restore.

/** Drops the click it came from, unless a later one has taken the field over. */
type UndoChoice = (() => void) & { readonly clickId?: symbol };

type ChoiceField = keyof typeof choice;

/** Which click each pending field belongs to. Identity, not value: clicking
 *  "acceptEdits", then "ask", then "acceptEdits" again makes three distinct
 *  claims on the field, and only the last one's undo may clear it. Plain, not
 *  `$state`: nothing renders it. A field the server has since confirmed leaves
 *  a stale entry here, which is harmless — its undo can only write the null
 *  that applying the response already wrote. */
const owner: Partial<Record<ChoiceField, symbol>> = {};

/** Show one field's click ahead of the server, and return that click's undo. */
function propose<K extends ChoiceField>(
	field: K,
	value: NonNullable<(typeof choice)[K]>,
): UndoChoice {
	const click = Symbol(field);
	owner[field] = click;
	choice[field] = value;
	return () => {
		if (owner[field] !== click) return;
		delete owner[field];
		choice[field] = null;
	};
}

/** Undo several fields as one click — each still owning its own field, so a
 *  refused model switch cannot revert a provider someone else's click set. */
const undoAll =
	(undos: readonly UndoChoice[]): UndoChoice =>
	() => {
		for (const undo of undos) undo();
	};

export function chooseAgent(agentId: string): UndoChoice {
	const key = catalogScope().key;
	const click = Symbol();
	agentCatalogs[key] = { ...agentsFor(), choice: { value: agentId, click } };
	return () => {
		const entry = agentCatalogs[key];
		if (entry?.choice?.click === click) entry.choice = null;
	};
}

export function chooseModel(model: {
	modelId: string;
	providerId: string;
}): UndoChoice {
	if (sessionState.currentId) {
		const current = getSessionPick(sessionState.currentId);
		const catalog = getActiveModel(model.modelId, model.providerId);
		const variants = catalog?.variants ?? [];
		const options = catalog?.contextWindowOptions ?? [];
		return chooseSessionPick(sessionState.currentId, {
			...model,
			variants,
			contextWindowOptions: options,
			variant: variants.includes(current?.variant ?? "")
				? (current?.variant ?? "")
				: "",
			contextWindow: options.some(
				(option) => option.value === current?.contextWindow,
			)
				? (current?.contextWindow ?? "")
				: "",
		});
	}
	draftPickChosen = true;
	setDraftModel(model);
	return () => {};
}

export function chooseVariant(variant: string): UndoChoice {
	if (sessionState.currentId)
		return chooseSessionPick(sessionState.currentId, { variant });
	if (
		draftModel &&
		(variant === "" || getActiveModelVariants().includes(variant))
	) {
		draftModel.variant = variant;
		draftPickChosen = true;
		rememberDraftModel();
	}
	return () => {};
}

export function chooseContextWindow(contextWindow: string): UndoChoice {
	if (sessionState.currentId)
		return chooseSessionPick(sessionState.currentId, { contextWindow });
	if (
		draftModel &&
		(contextWindow === "" ||
			getActiveContextWindowOptions().some(
				(option) => option.value === contextWindow,
			))
	) {
		draftModel.contextWindow = contextWindow;
		draftPickChosen = true;
		rememberDraftModel();
	}
	return () => {};
}

export function choosePermissionMode(mode: SessionPermissionMode): UndoChoice {
	if (!sessionState.currentId) {
		draft.permissionMode = mode;
		draftPermissionChosen = true;
		return () => {};
	}
	const key = catalogScope().key;
	const click = Symbol();
	modelCatalogs[key] = {
		...modelsFor(),
		permissionChoice: { value: mode, click },
	};
	return () => {
		const entry = modelCatalogs[key];
		if (entry?.permissionChoice?.click === click) entry.permissionChoice = null;
	};
}

export function chooseDefaultModel(model: {
	modelId: string;
	providerId: string;
}): UndoChoice {
	return undoAll([
		propose("defaultModelId", model.modelId),
		propose("defaultProviderId", model.providerId),
	]);
}

export function chooseDefaultPermissionMode(
	mode: SessionPermissionMode,
): UndoChoice {
	return propose("defaultPermissionMode", mode);
}

export function chooseHiddenEntries(entries: {
	hiddenModels?: string[];
	hiddenAgents?: string[];
}): UndoChoice {
	const undos: UndoChoice[] = [];
	if (entries.hiddenModels) {
		undos.push(propose("hiddenModels", [...entries.hiddenModels]));
	}
	if (entries.hiddenAgents) {
		undos.push(propose("hiddenAgents", [...entries.hiddenAgents]));
	}
	return undoAll(undos);
}

// The other half of a `choose*`: the server's answer, which lands in the
// server half and clears the click it confirms.

export function applyModelSwitched(response: SwitchModelResponse): void {
	handleModelInfo(response);
	handleVariantInfo(response);
}

export function applyDefaultModelSet(response: SetDefaultModelResponse): void {
	handleDefaultModelInfo({
		model: response.model,
		provider: response.provider,
		variant: response.variant,
	});
	handleVariantInfo(response);
}

export function applyVariantSwitched(response: SwitchVariantResponse): void {
	handleVariantInfo(response);
}

export function applyContextWindowSwitched(
	response: SwitchContextWindowResponse,
): void {
	handleContextWindowInfo({
		contextWindow: response.contextWindow,
		options: cloneContextWindowOptions(response.options) ?? [],
	});
}

export function applyHiddenEntriesSet(
	response: SetHiddenEntriesResponse,
): void {
	handleVisibilityInfo({
		hiddenModels: [...response.hiddenModels],
		hiddenAgents: [...response.hiddenAgents],
	});
}

export function applyDefaultPermissionMode(mode: SessionPermissionMode): void {
	serverDiscovery.defaultPermissionMode = mode;
	choice.defaultPermissionMode = null;
	if (!draftModel && !draftPermissionChosen) draft.permissionMode = mode;
}

export function applyDefaultSessionMode(mode: DefaultSessionMode): void {
	serverDiscovery.defaultSessionMode = mode;
}

/** Clear all discovery state (for project switch). */
export function clearDiscoveryState(): void {
	for (const id of Object.keys(sessionPicks)) delete sessionPicks[id];
	for (const key of Object.keys(modelCatalogs)) delete modelCatalogs[key];
	for (const project of Object.keys(accountModelCatalogs))
		delete accountModelCatalogs[project];
	for (const key of Object.keys(agentCatalogs)) delete agentCatalogs[key];
	for (const key of Object.keys(commandCatalogs)) delete commandCatalogs[key];
	for (const key of Object.keys(projectCatalogDefaults))
		delete projectCatalogDefaults[key];
	serverDiscovery.currentModelId = "";
	serverDiscovery.currentProviderId = "";
	serverDiscovery.sessionProviderIds = {};
	serverDiscovery.defaultModelId = "";
	serverDiscovery.defaultProviderId = "";
	serverDiscovery.defaultVariant = "";
	serverDiscovery.defaultsLoaded = false;
	serverDiscovery.harnessDefaults = missingHarnessDefaults();
	serverDiscovery.currentVariant = "";
	serverDiscovery.availableVariants = [];
	serverDiscovery.currentContextWindow = "";
	serverDiscovery.availableContextWindowOptions = [];
	serverDiscovery.permissionMode = "ask";
	serverDiscovery.defaultPermissionMode = "ask";
	serverDiscovery.hiddenModels = [];
	serverDiscovery.hiddenAgents = [];
	clearDraftSelection();
	for (const field of Object.keys(choice) as ChoiceField[]) {
		choice[field] = null;
		delete owner[field];
	}
}
