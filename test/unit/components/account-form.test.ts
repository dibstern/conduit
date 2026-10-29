import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AccountForm from "../../../src/lib/frontend/components/overlays/AccountForm.svelte";
import { createAccountForm } from "../../../src/lib/frontend/components/overlays/account-form.svelte.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import type { InstanceListResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import type { OpenCodeInstance } from "../../../src/lib/frontend/types.js";

// Failure modes: a standalone host cannot open a chosen harness or account;
// edits or reverting edits report the wrong dirty state; Add reports an existing
// or concurrently added account; Save loses the edit id; failed/invalid saves
// close the form; an old response closes a newly opened form; Cancel fails to
// notify its host; unchanged environment overrides are accidentally erased.
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/stores/server-status.svelte.js", () => ({
	refreshServerStatus: vi.fn().mockResolvedValue(undefined),
}));

const account: OpenCodeInstance = {
	id: "work-claude",
	name: "Work Claude",
	driver: "claude",
	configDir: "/profiles/work",
	port: 0,
	managed: false,
	status: "healthy",
	restartCount: 0,
	createdAt: 1,
	env: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
};

beforeEach(() => {
	vi.mocked(rpc).mockReset();
	applyInstanceListResponse({ instances: [account] });
});
afterEach(cleanup);

it.each([
	"claude",
	"codex",
	"opencode",
	"cursor",
] as const)("opens Add for %s outside the Instances list and reports reversible edits and Cancel", async (driver) => {
	const onclose = vi.fn();
	const form = createAccountForm({ onclose });
	form.openAdd(driver);
	const view = render(AccountForm, { props: { form } });
	expect(
		view
			.getByTestId(`instance-form-driver-${driver}`)
			.getAttribute("aria-checked"),
	).toBe("true");
	expect(form.dirty).toBe(false);
	await fireEvent.input(view.getByTestId("instance-form-name"), {
		target: { value: "Changed" },
	});
	expect(form.dirty).toBe(true);
	await fireEvent.input(view.getByTestId("instance-form-name"), {
		target: { value: "" },
	});
	expect(form.dirty).toBe(false);
	await fireEvent.click(view.getByTestId("instance-form-cancel"));
	expect(onclose).toHaveBeenCalledOnce();
	expect(view.queryByTestId("instance-form")).toBeNull();
	expect(form.dirty).toBe(false);
});

it.each([
	false,
	true,
])("reports the newly added account id from the response list with id hint %s", async (hasIdHint) => {
	const onsave = vi.fn();
	const onclose = vi.fn();
	const form = createAccountForm({ onsave, onclose });
	form.openAdd("codex");
	const view = render(AccountForm, { props: { form } });
	await fireEvent.input(view.getByTestId("instance-form-name"), {
		target: { value: "New Codex" },
	});
	const added = {
		...account,
		id: "new-codex",
		name: "New Codex",
		driver: "codex",
	};
	vi.mocked(rpc).mockResolvedValueOnce({
		instances: [
			account,
			{ ...(hasIdHint ? added : account), id: "concurrent" },
			added,
		],
		...(hasIdHint ? { addedInstanceId: added.id } : {}),
	});
	await fireEvent.submit(view.getByTestId("instance-form"));
	await waitFor(() => expect(onsave).toHaveBeenCalledWith("new-codex"));
	expect(onclose).toHaveBeenCalledOnce();
	expect(form.dirty).toBe(false);
});

it("opens an account, tracks all editable fields, and saves its id without clearing unchanged env", async () => {
	const onsave = vi.fn();
	const form = createAccountForm({ onsave });
	form.openEdit(account);
	const view = render(AccountForm, { props: { form } });
	expect(view.getByRole("heading", { name: "Edit Work Claude" })).toBeDefined();
	expect(form.dirty).toBe(false);
	await fireEvent.input(view.getByTestId("instance-form-configdir"), {
		target: { value: "/profiles/other" },
	});
	expect(form.dirty).toBe(true);
	await fireEvent.input(view.getByTestId("instance-form-configdir"), {
		target: { value: account.configDir },
	});
	expect(form.dirty).toBe(false);
	await fireEvent.input(view.getByTestId("instance-form-name"), {
		target: { value: "Renamed" },
	});
	vi.mocked(rpc).mockResolvedValueOnce({
		instances: [{ ...account, name: "Renamed" }],
	});
	await fireEvent.submit(view.getByTestId("instance-form"));
	await waitFor(() => expect(onsave).toHaveBeenCalledWith(account.id));
	expect(rpc).toHaveBeenCalledWith("UpdateInstance", {
		instanceId: account.id,
		name: "Renamed",
		configDir: account.configDir,
	});
});

it("keeps invalid and failed saves open without emitting saved or closed", async () => {
	const onsave = vi.fn();
	const onclose = vi.fn();
	const form = createAccountForm({ onsave, onclose });
	form.openAdd("claude");
	const view = render(AccountForm, { props: { form } });
	await fireEvent.submit(view.getByTestId("instance-form"));
	expect(rpc).not.toHaveBeenCalled();
	await fireEvent.input(view.getByTestId("instance-form-name"), {
		target: { value: "New" },
	});
	vi.mocked(rpc).mockRejectedValueOnce(new Error("Failed"));
	await fireEvent.submit(view.getByTestId("instance-form"));
	await waitFor(() =>
		expect(
			view.getByTestId("instance-form-save").hasAttribute("disabled"),
		).toBe(false),
	);
	expect(view.getByTestId("instance-form")).toBeDefined();
	expect(form.dirty).toBe(true);
	expect(onsave).not.toHaveBeenCalled();
	expect(onclose).not.toHaveBeenCalled();
});

it("does not close a newly opened form when an older save finishes", async () => {
	const onclose = vi.fn();
	const form = createAccountForm({ onclose });
	form.openEdit(account);
	const view = render(AccountForm, { props: { form } });
	let resolveSave: (response: InstanceListResponse) => void = () => {};
	vi.mocked(rpc).mockReturnValueOnce(
		new Promise<InstanceListResponse>((resolve) => {
			resolveSave = resolve;
		}),
	);
	await fireEvent.submit(view.getByTestId("instance-form"));
	form.openAdd("codex");
	resolveSave({ instances: [account] });
	await waitFor(() =>
		expect(view.getByTestId("instance-form-save").textContent?.trim()).toBe(
			"Add instance",
		),
	);
	expect(onclose).not.toHaveBeenCalled();
	expect(form.dirty).toBe(false);
});
