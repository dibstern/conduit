import {
	applyDetectProxyResponse,
	applyInstanceListResponse,
	applyScanNowResponse,
	beginProxyDetection,
	beginScan,
	clearScanInFlight,
} from "../stores/instance.svelte.js";
import { refreshServerStatus } from "../stores/server-status.svelte.js";
import { confirm } from "../stores/ui.svelte.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";

/** Account commands shared by settings hosts; confirmation and errors stay here. */
export function createAccountActions() {
	let defaultSaving = $state(false);

	function start(instanceId: string) {
		return rpc("StartInstance", { instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(toastFailure("Failed to start instance", "warn"));
	}

	function stop(instanceId: string) {
		return rpc("StopInstance", { instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(toastFailure("Failed to stop instance", "warn"));
	}

	async function makeDefault(instanceId: string) {
		if (defaultSaving) return;
		defaultSaving = true;
		try {
			applyInstanceListResponse(await rpc("SetDefault", { instanceId }));
		} catch (error: unknown) {
			toastFailure("Failed to change default account", "warn")(error);
		} finally {
			defaultSaving = false;
		}
	}

	async function remove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(
			`Remove instance "${instanceName}"? This cannot be undone.`,
		);
		if (confirmed) {
			await rpc("RemoveInstance", { instanceId })
				.then(applyInstanceListResponse)
				.then(refreshServerStatus)
				.catch(toastFailure("Failed to remove instance", "warn"));
		}
	}

	function scan() {
		beginScan();
		return rpc("ScanNow", {})
			.then(applyScanNowResponse)
			.then(refreshServerStatus)
			.catch((error: unknown) => {
				clearScanInFlight();
				toastFailure("Port scan failed", "warn")(error);
			});
	}

	function detectProxy() {
		beginProxyDetection();
		return rpc("DetectProxy", {})
			.then(applyDetectProxyResponse)
			.catch(() => applyDetectProxyResponse({ found: false, port: 8317 }));
	}

	return {
		get defaultSaving() {
			return defaultSaving;
		},
		start,
		stop,
		makeDefault,
		remove,
		scan,
		detectProxy,
	};
}
