import { expect, userEvent, within } from "storybook/test";
import { type ShowStop, STOPS } from "../utils/turn-stops.js";

type ShowChoice = ShowStop | "qa";

function tabName(choice: ShowChoice): string | RegExp {
	if (choice === "qa") return "Q&A";
	// A lone log stop (Jev off) is labelled Log rather than Full log.
	if (choice === "log") return /^(Full log|Log)$/;
	return STOPS[choice].short;
}

/** Opens a collapsed turn the way a reader would, by its head. */
export async function expandTurn(canvasElement: HTMLElement): Promise<void> {
	const head = canvasElement.querySelector<HTMLButtonElement>(
		".turn-activity-toggle",
	);
	if (!head) throw new Error("Missing turn head");
	if (head.getAttribute("aria-expanded") === "false")
		await userEvent.click(head);
	head.blur();
}

/** Phones pick a Show stop from the footer menu; wider panels use the footer tabs. */
export async function showTurnStop(
	canvasElement: HTMLElement,
	choice: ShowChoice,
): Promise<void> {
	const canvas = within(canvasElement);
	const trigger = canvas.queryByRole("button", { name: "Show messages" });
	if (!trigger) {
		await userEvent.click(canvas.getByRole("tab", { name: tabName(choice) }));
		return;
	}
	await userEvent.click(trigger);
	const menu = within(canvasElement.ownerDocument.body).getByRole("menu", {
		name: "Show, least to most",
	});
	await userEvent.click(
		within(menu).getByRole("menuitemradio", {
			name: choice === "qa" ? "Q&A" : STOPS[choice].menu,
		}),
	);
}

export async function expectTurnStop(
	canvasElement: HTMLElement,
	choice: ShowChoice,
): Promise<void> {
	const canvas = within(canvasElement);
	const trigger = canvas.queryByRole("button", { name: "Show messages" });
	if (trigger)
		await expect(trigger).toHaveTextContent(
			`Show · ${choice === "qa" ? "Q&A" : STOPS[choice].menu}`,
		);
	else
		await expect(
			canvas.getByRole("tab", { name: tabName(choice) }),
		).toHaveAttribute("aria-selected", "true");
}

/** A selected pin keeps its secondary number and takes a category tint and ring (xdyjq.17). */
export async function expectSelectedPin(pin: Element): Promise<void> {
	const probe = pin.ownerDocument.createElement("span");
	probe.style.color = "var(--color-text-secondary)";
	probe.style.backgroundColor =
		"color-mix(in srgb, var(--surface-colour, var(--color-text-secondary)) 14%, var(--color-turn-bg))";
	probe.style.borderColor =
		"var(--surface-colour, var(--color-text-secondary))";
	pin.append(probe);
	const { color, backgroundColor, borderTopColor } = getComputedStyle(probe);
	probe.remove();
	const paint = getComputedStyle(pin);
	await expect(paint.color).toBe(color);
	await expect(paint.backgroundColor).toBe(backgroundColor);
	await expect(paint.boxShadow).toBe(`${borderTopColor} 0px 0px 0px 1px inset`);
}
