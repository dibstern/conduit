import { mount } from "svelte";
import RewindBanner from "../../../src/lib/frontend/components/overlays/RewindBanner.svelte";
import Toast from "../../../src/lib/frontend/components/overlays/Toast.svelte";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { attachedProjectState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	enterRewindMode,
	selectRewindMessage,
} from "../../../src/lib/frontend/stores/ui.svelte.js";

attachedProjectState.slug = "myapp";
sessionState.currentId = "rewind-session";
getOrCreateSessionActivity("rewind-session");
getOrCreateSessionMessages("rewind-session").messages = [
	{
		type: "user",
		uuid: "selected-message",
		messageId: "provider-message",
		text: "Rewind to this message",
	},
];
enterRewindMode();
selectRewindMessage("selected-message");
mount(RewindBanner, { target: document.body });
mount(Toast, { target: document.body });
