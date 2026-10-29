import {
	isKnownDriverKind,
	type KnownProviderDriverKind,
} from "../../../contracts/provider-instance.js";
import {
	applyInstanceListResponse,
	getCachedInstances,
	getDriverTraits,
} from "../../stores/instance.svelte.js";
import { refreshServerStatus } from "../../stores/server-status.svelte.js";
import { showToast } from "../../stores/ui.svelte.js";
import { toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import type { OpenCodeInstance } from "../../types.js";
import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";

type AccountFormTarget = { mode: "add" } | { mode: "edit"; accountId: string };

/** Each host owns a controller, and mounts AccountForm wherever it needs it. */
export function createAccountForm({
	onclose,
	onsave,
}: {
	onclose?: (target: AccountFormTarget) => void;
	onsave?: (accountId: string) => void;
} = {}) {
	const empty = {
		formDriver: "claude" as KnownProviderDriverKind,
		formName: "",
		formConfigDir: "",
		formManaged: true,
		formPort: "",
		formUrl: "",
		formEnv: "",
		initialFormEnv: "",
		formEnvOpen: false,
		formSaving: false,
	};
	const state = $state({ ...empty });
	let target = $state.raw<AccountFormTarget | null>(null);
	let initialValues = $state("");
	const traits = $derived(getDriverTraits(state.formDriver));
	const presentation = $derived(PROVIDER_PRESENTATION[state.formDriver]);
	const editingId = $derived(target?.mode === "edit" ? target.accountId : null);
	const dirty = $derived(target !== null && fieldValues() !== initialValues);

	function fieldValues() {
		return JSON.stringify([
			state.formDriver,
			state.formName,
			state.formConfigDir,
			state.formManaged,
			state.formPort,
			state.formUrl,
			state.formEnv,
		]);
	}

	function openAdd(driver: KnownProviderDriverKind) {
		Object.assign(state, empty, { formDriver: driver });
		target = { mode: "add" };
		initialValues = fieldValues();
	}

	function openEdit(account: OpenCodeInstance) {
		Object.assign(state, empty, {
			formDriver: isKnownDriverKind(account.driver)
				? account.driver
				: "opencode",
			formName: account.name,
			formConfigDir: account.configDir ?? "",
			formManaged: account.managed ?? false,
			formPort: account.port ? String(account.port) : "",
			formUrl: account.url ?? `http://127.0.0.1:${account.port}`,
			formEnv: account.env
				? Object.entries(account.env)
						.map(([k, v]) => `${k}=${v}`)
						.join("\n")
				: "",
		});
		state.initialFormEnv = state.formEnv;
		target = { mode: "edit", accountId: account.id };
		initialValues = fieldValues();
	}

	function close() {
		const closed = target;
		target = null;
		Object.assign(state, empty);
		if (closed) onclose?.(closed);
	}

	/** Parse KEY=VALUE lines; blank lines and comments are ignored. */
	function parseEnv(text: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
		return Object.keys(env).length > 0 ? env : undefined;
	}

	async function save() {
		if (state.formSaving || target === null) return;
		const submitted = target;
		const name = state.formName.trim();
		if (!name) {
			showToast("Instance name is required", { variant: "warn" });
			return;
		}
		const usesConfigDirectory = traits?.accountKind === "config-directory";
		const endpoint = state.formUrl.trim();
		const portText = state.formManaged
			? state.formPort.trim()
			: /^\d+$/.test(endpoint)
				? endpoint
				: "";
		const port = portText ? Number(portText) : undefined;
		if (
			traits?.runsOpenCodeServer &&
			port !== undefined &&
			(!Number.isInteger(port) || port < 1 || port > 65535)
		) {
			showToast("Port must be a whole number between 1 and 65535", {
				variant: "warn",
			});
			return;
		}
		if (traits?.runsOpenCodeServer && !state.formManaged && !endpoint) {
			showToast("URL is required", { variant: "warn" });
			return;
		}
		const env =
			(traits?.runsOpenCodeServer && state.formManaged) ||
			presentation.environment
				? parseEnv(state.formEnv)
				: undefined;
		const configEnv =
			presentation.environment && state.formEnv !== state.initialFormEnv
				? { env: env ?? {} }
				: {};
		const configDir = state.formConfigDir.trim() || undefined;
		const url =
			!state.formManaged && port === undefined
				? endpoint || undefined
				: undefined;
		const driver = state.formDriver;
		const previousIds = new Set(
			getCachedInstances().map((account) => account.id),
		);
		state.formSaving = true;
		try {
			const response =
				submitted.mode === "edit"
					? await rpc("UpdateInstance", {
							instanceId: submitted.accountId,
							name,
							...(usesConfigDirectory
								? { configDir: configDir ?? "", ...configEnv }
								: state.formManaged
									? { ...(port !== undefined ? { port } : {}), env: env ?? {} }
									: {}),
						})
					: await rpc("AddInstance", {
							name,
							driver,
							...(usesConfigDirectory
								? {
										managed: false,
										...(configDir !== undefined ? { configDir } : {}),
										...configEnv,
									}
								: {
										managed: state.formManaged,
										...(port !== undefined ? { port } : {}),
										...(url !== undefined ? { url } : {}),
										...(env !== undefined ? { env } : {}),
									}),
						});
			applyInstanceListResponse(response);
			await refreshServerStatus();
			const savedId =
				submitted.mode === "edit"
					? submitted.accountId
					: response.instances.find(
							(account) =>
								!previousIds.has(account.id) &&
								account.name === name &&
								(account.driver ?? "opencode") === driver &&
								(response.addedInstanceId === undefined ||
									account.id === response.addedInstanceId),
						)?.id;
			if (savedId) onsave?.(savedId);
			if (target === submitted) close();
		} catch (error: unknown) {
			toastFailure(
				`Failed to ${submitted.mode === "edit" ? "update" : "add"} instance`,
				"warn",
			)(error);
		} finally {
			if (target === submitted) state.formSaving = false;
		}
	}

	return {
		state,
		get mode() {
			return target?.mode ?? null;
		},
		get editingId() {
			return editingId;
		},
		get traits() {
			return traits;
		},
		get presentation() {
			return presentation;
		},
		get dirty() {
			return dirty;
		},
		openAdd,
		openEdit,
		close,
		save,
	};
}

export type AccountFormController = ReturnType<typeof createAccountForm>;
