import { getBrowserClientId } from "../stores/client-identity.js";
import { getInstanceById } from "../stores/instance.svelte.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";

export function showAccountSwitchRefusal(
	instanceId: string,
	error: unknown,
): void {
	toastFailure(
		`Couldn't switch to ${getInstanceById(instanceId)?.name ?? instanceId}`,
	)(error);
}

export async function switchSessionAccount(
	input: Omit<Parameters<typeof rpc<"ContinueSession">>[1], "at" | "originId">,
): Promise<boolean> {
	try {
		await rpc("ContinueSession", { ...input, originId: getBrowserClientId() });
		return true;
	} catch (error) {
		showAccountSwitchRefusal(input.instanceId, error);
		return false;
	}
}
