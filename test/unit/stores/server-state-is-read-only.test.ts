// ─── Server-owned reads are read-only ────────────────────────────────────────
// The split gives each store a server half that only the `apply*`/`handle*`
// functions may write. Marking the *getters* read-only is not enough: a
// `ReadonlyMap<string, SessionInfo>` still hands out a mutable row, and a
// `readonly ProviderInfo[]` still hands out a mutable `models` array. A
// component that edits one of those corrupts the copy of the server's truth
// that every other component reads — silently, and only until the next
// broadcast overwrites it.
//
// So the assertion here is `pnpm check`, not `expect`: every `@ts-expect-error`
// below must mark a real error, and an unused directive is itself an error.
// The stores are empty, so each guarded block is dead code at runtime — this
// file compiles the mistakes rather than making them.

import { describe, expect, it } from "vitest";
import { claudeSettingsState } from "../../../src/lib/frontend/stores/claude-settings.svelte.js";
import {
	discoveryState,
	getAvailableInstances,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	getScrollback,
	getTabList,
	terminalState,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";

describe("the server half of a store", () => {
	it("cannot be written through the read view", () => {
		expect(sessionState.sessions.size).toBe(0);
		const session = sessionState.sessions.get("ses_probe");
		if (session) {
			// @ts-expect-error a session row belongs to the server
			session.title = "renamed here";
		}

		expect(discoveryState.agents).toHaveLength(0);
		const [agent] = discoveryState.agents;
		if (agent) {
			// @ts-expect-error an agent row belongs to the server
			agent.name = "local";
		}

		expect(discoveryState.providers).toHaveLength(0);
		const [provider] = discoveryState.providers;
		if (provider) {
			// @ts-expect-error a provider's model list belongs to the server
			provider.models.splice(0);
		}

		expect(claudeSettingsState.projectSlug).toBeNull();
		if (claudeSettingsState.projectSlug) {
			// Bracket access, so the only error left is the ownership one: reading
			// an index signature with a dot is its own error (TS4111), and it would
			// keep this directive satisfied long after the readonly went missing.
			// @ts-expect-error the relay's settings belong to the server
			claudeSettingsState.overrides["autoCompactEnabled"] = false;
		}

		expect(discoveryState.agentProviderScope).toBeNull();
		const scope = discoveryState.agentProviderScope;
		if (scope) {
			// @ts-expect-error the scope agents are hidden against belongs to the server
			scope.id = "wrong";
		}

		expect(getAvailableInstances()).toHaveLength(0);
		const [instance] = getAvailableInstances();
		if (instance) {
			// @ts-expect-error an instance option is derived; writing it changes nothing
			instance.label = "renamed here";
		}

		expect(terminalState.tabs.size).toBe(0);
		const tab = terminalState.tabs.get("pty_probe");
		if (tab) {
			// @ts-expect-error a tab row is derived; writing it changes nothing
			tab.exited = true;
		}

		expect(getTabList()).toHaveLength(0);
		const [listed] = getTabList();
		if (listed) {
			// @ts-expect-error same rows, same rule, through the helper
			listed.exited = true;
		}

		const scrollback = getScrollback("pty_probe");
		expect(scrollback).toHaveLength(0);
		if (scrollback.length > 0) {
			// @ts-expect-error the scrollback buffer is the store's own array
			scrollback[0] = "rewritten";
		}
	});
});
