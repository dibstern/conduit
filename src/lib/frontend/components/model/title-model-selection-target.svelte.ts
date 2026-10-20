import {
	BUILTIN_TITLE_GENERATION,
	type TitleGenerationSelection,
} from "../../../contracts/title-generation.js";
import {
	applyTitleGeneration,
	discoveryState,
	getAvailableInstances,
	getModelCatalogForInstance,
	getProviderGroupsForInstance,
	loadModelCatalog,
	modelMatchesId,
} from "../../stores/discovery.svelte.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import { showToast } from "../../stores/ui.svelte.js";
import { toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import type { ModelSelectionTarget } from "./model-selection-target.js";

export function createTitleModelSelectionTarget() {
	let saving = $state(false);
	let localSelection = $state<TitleGenerationSelection | null>(null);
	const selection = $derived(
		(saving ? localSelection : discoveryState.titleGeneration.selection) ??
			BUILTIN_TITLE_GENERATION,
	);
	// Remove this filter when OpenCode and Cursor generation land in 9mbo.6/.7.
	const accounts = $derived(
		getAvailableInstances().filter((account) => account.driver === "claude"),
	);
	const accountId = $derived.by(() => {
		const ref = selection.account;
		return ref._tag === "Id"
			? ref.id
			: accounts.find(
					(account) => account.driver === ref.driver && account.isDefault,
				)?.id;
	});
	const inventory = $state({ loading: false, error: null as string | null });
	let catalogRead:
		| { project: string; account: string; promise: Promise<void> }
		| undefined;

	function loadCatalog(
		project: string,
		account: string,
		refresh = false,
	): Promise<void> {
		if (
			catalogRead?.project === project &&
			catalogRead.account === account &&
			(!refresh || inventory.loading)
		)
			return catalogRead.promise;
		inventory.loading = true;
		inventory.error = null;
		const read = {
			project,
			account,
			promise: loadModelCatalog(project, account),
		};
		catalogRead = read;
		read.promise = read.promise.then(
			() => {
				if (catalogRead === read) inventory.loading = false;
			},
			(error: unknown) => {
				if (catalogRead === read) {
					catalogRead = undefined;
					inventory.loading = false;
					inventory.error = "Couldn't load models for this account.";
				}
				throw error;
			},
		);
		return read.promise;
	}

	$effect(() => {
		const project = getCurrentSlug();
		if (project && accountId)
			void loadCatalog(project, accountId).catch(() => undefined);
	});

	async function save(
		next: TitleGenerationSelection | null,
		changingAccount = false,
	): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug || saving) return;
		saving = true;
		localSelection = next;
		try {
			if (next?.account._tag === "Id") {
				await loadCatalog(projectSlug, next.account.id);
				if (changingAccount) {
					const models = getModelCatalogForInstance(
						next.account.id,
						projectSlug,
					).flatMap((provider) => provider.models);
					const previous = models.find(
						(model) =>
							model.provider === next?.providerId &&
							modelMatchesId(model, next?.modelId),
					);
					const model =
						previous ??
						models.find((model) => modelMatchesId(model, "opus")) ??
						models[0];
					if (!model) {
						inventory.error = "No models available for this account.";
						showToast(inventory.error, { variant: "warn" });
						return;
					}
					next = {
						...next,
						providerId: model.provider,
						modelId: previous ? next.modelId : model.id,
						effort: model.variants?.includes(next.effort) ? next.effort : "",
					};
					localSelection = next;
				}
			}
			const response = await rpc("SetTitleGeneration", {
				projectSlug,
				selection: next,
			});
			applyTitleGeneration(response);
		} catch (error) {
			toastFailure("Failed to save title generation setting", "warn")(error);
		} finally {
			saving = false;
		}
	}

	const target: ModelSelectionTarget = {
		get pick() {
			return {
				account: accountId,
				driver: accounts.find((account) => account.id === accountId)?.driver,
				providerId: selection.providerId,
				modelId: selection.modelId,
				effort: selection.effort,
				contextWindow: null,
			};
		},
		get accounts() {
			return accounts;
		},
		get catalog() {
			return getProviderGroupsForInstance(accountId, getCurrentSlug() ?? "");
		},
		get activeModel() {
			return accountId
				? getModelCatalogForInstance(accountId, getCurrentSlug() ?? "")
						.find((provider) => provider.id === selection.providerId)
						?.models.find((model) => modelMatchesId(model, selection.modelId))
				: undefined;
		},
		get inventory() {
			return inventory;
		},
		get loading() {
			return false;
		},
		get effortOptions() {
			return this.activeModel?.variants?.length
				? ["", ...this.activeModel.variants]
				: [];
		},
		get contextWindowOptions() {
			return [];
		},
		get pending() {
			return { model: saving, effort: saving, contextWindow: saving };
		},
		selectAccount(id) {
			if (
				!accounts.some(
					(account) => account.id === id && account.available !== false,
				)
			)
				return;
			void save({ ...selection, account: { _tag: "Id", id } }, true);
		},
		selectModel(pick) {
			if (!accountId) return;
			const model = this.catalog
				.find((group) => group.provider.id === pick.providerId)
				?.models.find((model) => modelMatchesId(model, pick.modelId));
			if (!model) return;
			void save({
				account: { _tag: "Id", id: accountId },
				...pick,
				effort: model.variants?.includes(selection.effort)
					? selection.effort
					: "",
			});
		},
		selectEffort(effort) {
			if (!accountId) return;
			void save({
				...selection,
				account: { _tag: "Id", id: accountId },
				effort,
			});
		},
		selectContextWindow() {},
	};
	return {
		target,
		get saving() {
			return saving;
		},
		refreshCatalog() {
			const project = getCurrentSlug();
			if (project && accountId)
				void loadCatalog(project, accountId, true).catch(() => undefined);
		},
		reset() {
			void save(null);
		},
	};
}
