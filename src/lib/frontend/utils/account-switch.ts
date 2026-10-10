import { getBrowserClientId } from "../stores/client-identity.js";
import { getInstanceById } from "../stores/instance.svelte.js";
import { showToast } from "../stores/ui.svelte.js";
import {
	type ContinueSessionRpcInput,
	continueSessionRpc,
} from "../transport/ws-rpc-client.js";

export function showAccountSwitchRefusal(
	instanceId: string,
	error: unknown,
): void {
	showToast({
		title: `Couldn't switch to ${getInstanceById(instanceId)?.name ?? instanceId}`,
		...(error instanceof Error && error.message ? { body: error.message } : {}),
		variant: "error",
	});
}

export async function switchSessionAccount(
	input: Omit<ContinueSessionRpcInput, "at" | "originId">,
): Promise<boolean> {
	try {
		await continueSessionRpc({ ...input, originId: getBrowserClientId() });
		return true;
	} catch (error) {
		showAccountSwitchRefusal(input.instanceId, error);
		return false;
	}
}
