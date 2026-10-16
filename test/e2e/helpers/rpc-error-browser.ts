import { mount } from "svelte";
import Toast from "../../../src/lib/frontend/components/overlays/Toast.svelte";
import {
	copy,
	toastFailure,
} from "../../../src/lib/frontend/transport/rpc-errors.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

mount(Toast, { target: document.body });
async function showRpcFailure(nullCopy = false) {
	const original = copy.WorkspaceMoveError;
	if (nullCopy) Object.assign(copy, { WorkspaceMoveError: null });
	try {
		await rpc("MoveSessionWorkspace", {
			projectSlug: "workspace",
			sessionId: "session",
			path: "/gone",
		}).catch(toastFailure("Could not move session"));
	} finally {
		Object.assign(copy, { WorkspaceMoveError: original });
	}
}
declare global {
	interface Window {
		showRpcFailure: typeof showRpcFailure;
	}
}
window.showRpcFailure = showRpcFailure;
