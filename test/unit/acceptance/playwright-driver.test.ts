import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { afterEach, expect, test, vi } from "vitest";
import {
	PHONE_VIEWPORT,
	PlaywrightDriver,
} from "../../../acceptance/src/playwrightDriver.js";

vi.mock("../../e2e/helpers/visual-helpers.js", () => ({
	waitForFonts: vi.fn(),
	waitForIcons: vi.fn(),
	freezeAnimations: vi.fn(),
	screenshotLocator: vi.fn(async () => Buffer.from("captured region")),
	compareImages: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test.each([
	{ env: undefined, name: "desktop", width: 1440, height: 900 },
	{ env: "phone", name: "phone", width: 393, height: 852 },
	{ env: "800x600", name: "800x600", width: 800, height: 600 },
])("scenario viewport resets to $name and selects its baseline directory", async ({
	env,
	name,
	width,
	height,
}) => {
	vi.stubEnv("VIEWPORT", env);
	vi.stubEnv("VISUAL_ACCEPTANCE_BASELINE_ROOT", undefined);
	const root = await mkdtemp(join(tmpdir(), "conduit-viewport-"));
	vi.spyOn(process, "cwd").mockReturnValue(root);
	const page = {
		setViewportSize: vi.fn(),
		locator: vi.fn(() => ({ waitFor: vi.fn() })),
	} as unknown as Page;
	const newContext = vi.fn(async () => ({
		addInitScript: vi.fn(),
		newPage: vi.fn(async () => page),
		close: vi.fn(),
	}));
	const driver = new PlaywrightDriver();
	vi.spyOn(driver, "launch").mockResolvedValue({
		newContext,
	} as unknown as Browser);

	try {
		await driver.newExecution();
		await driver.setViewport(page, PHONE_VIEWPORT);
		expect(page.setViewportSize).toHaveBeenCalledWith({
			width: 393,
			height: 852,
		});
		await driver.matchRegion(page, "layout", "#layout", "phone", 98, "capture");
		expect(
			await readFile(
				join(root, "acceptance/visual/baselines/phone/phone.png"),
				"utf8",
			),
		).toBe("captured region");

		await driver.newExecution();
		expect(newContext).toHaveBeenLastCalledWith(
			expect.objectContaining({ viewport: { width, height } }),
		);
		await driver.matchRegion(
			page,
			"layout",
			"#layout",
			"default",
			98,
			"capture",
		);
		expect(
			await readFile(
				join(root, `acceptance/visual/baselines/${name}/default.png`),
				"utf8",
			),
		).toBe("captured region");
	} finally {
		await driver.close();
		await rm(root, { recursive: true, force: true });
	}
});
