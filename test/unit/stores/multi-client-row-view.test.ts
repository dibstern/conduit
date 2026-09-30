import { expect, it, vi } from "vitest";

vi.hoisted(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
});

it("two client stores render the same row changes from their root snapshots", async () => {
	const first = await import(
		"../../../src/lib/frontend/stores/session.svelte.js"
	);
	const firstFeed = await import(
		"../../../src/lib/frontend/transport/session-subscription.svelte.js"
	);
	vi.resetModules();
	const second = await import(
		"../../../src/lib/frontend/stores/session.svelte.js"
	);
	const secondFeed = await import(
		"../../../src/lib/frontend/transport/session-subscription.svelte.js"
	);
	const clients = [
		{ store: first, feed: firstFeed },
		{ store: second, feed: secondFeed },
	];

	for (const client of clients) {
		client.feed.applySessionChange({
			_tag: "snapshot",
			sequence: 1,
			rows: [{ id: "shared", title: "Shared", status: "idle", unread: true }],
		});
	}
	expect(
		clients.map((client) => client.store.getSessionIndicator("shared", null)),
	).toEqual(["done-unviewed", "done-unviewed"]);

	for (const client of clients) {
		client.feed.applySessionChange({
			_tag: "snapshot",
			sequence: 2,
			rows: [
				{
					id: "shared",
					title: "Shared",
					status: "idle",
					unread: false,
					pendingPermissionCount: 1,
				},
			],
		});
	}
	expect(
		clients.map((client) => client.store.getSessionIndicator("shared", null)),
	).toEqual(["attention", "attention"]);
});
