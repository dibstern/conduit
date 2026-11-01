// Failure cases: segment-local indices, tiny/concurrent steps, long waits,
// missing timestamps, compaction boundaries, overlapping hand-backs, and live
// paint must not hide steps or put navigation in a different coordinate space.
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { HistoryMessagePartSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { chooseShowStop } from "./turnActivityShow.js";

type Part = typeof HistoryMessagePartSchema.Type;
const SESSION = "sess-strip-bands";
const START = PINNED_CLOCK_MS - 1_166_000;

export const turnStripHandlers: StepHandler[] = [
	{
		name: "assert surfaced chips keep painted hit areas",
		match:
			/^surfaced message chips keep their painted hit area beside question markers$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-minimise-toggle").click();
			await expect(world.page.locator(".pin-lane")).toBeVisible();
			const target = await world.page
				.locator(".turn-activity")
				.evaluate((panel) => {
					for (const chip of panel.querySelectorAll<HTMLElement>(".pin-chip")) {
						const box = chip.getBoundingClientRect();
						for (const pin of panel.querySelectorAll<HTMLElement>(
							"[data-hand-back]",
						)) {
							const face = pin.getBoundingClientRect();
							const left = Math.max(box.left, face.left - 6);
							const right = Math.min(box.right, face.right + 6);
							if (right - left > 2)
								return {
									x: (left + right) / 2,
									// Stay above the strip container's existing 1.5px
									// overlap and inside the enlarged target's regression.
									y: box.bottom - 3,
									id: chip
										.closest("[data-surface-part]")
										?.getAttribute("data-surface-part"),
								};
						}
					}
					throw new Error(
						"Fixture must put a surfaced chip beside a question target",
					);
				});
			await world.page.mouse.click(target.x, target.y);
			await expect(
				world.page.locator(`[data-surface-part="${target.id}"]`),
			).toHaveAttribute("aria-pressed", "true");
			await expect(
				world.page.getByRole("region", { name: "Turn Q&A", exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert exposed question paint",
		match: /^every question band exposes its own colour around its marker$/,
		run: async ({ world }) => {
			const pins = world.page.getByTestId("turn-hand-back-pin");
			expect(await pins.count()).toBeGreaterThan(0);
			await pins.first().scrollIntoViewIfNeeded();
			for (const pin of (await pins.all()).reverse()) {
				const id = await pin.getAttribute("data-hand-back");
				const paint = await pin.evaluate((marker, id) => {
					const band = marker.parentElement?.querySelector<HTMLElement>(
						`button[data-step-id="${id}"]`,
					);
					if (!band) throw new Error(`Missing question band ${id}`);
					const box = band.getBoundingClientRect();
					const face = marker.getBoundingClientRect();
					// Include the opaque 1px ring in the marker's painted footprint.
					const exposed =
						Math.max(0, Math.min(box.right, face.left - 1) - box.left) +
						Math.max(0, box.right - Math.max(box.left, face.right + 1));
					const x =
						face.left - 1 > box.left
							? box.left + Math.min(exposed / 4, 0.5)
							: box.right - Math.min(exposed / 4, 0.5);
					const probe = document.createElement("span");
					probe.style.backgroundColor = band.classList.contains("live-segment")
						? "var(--color-accent)"
						: "var(--color-act-other)";
					band.append(probe);
					const result = {
						exposed,
						actual: getComputedStyle(band).backgroundColor,
						expected: getComputedStyle(probe).backgroundColor,
						// Ignore transparent hit extensions, but include all opaque overlays.
						visible:
							document
								.elementsFromPoint(x, box.top + box.height / 2)
								.find((node) => {
									if (node === band || node.contains(band)) return true;
									const rect = node.getBoundingClientRect();
									return (
										x >= rect.left &&
										x <= rect.right &&
										getComputedStyle(node).backgroundColor !==
											"rgba(0, 0, 0, 0)"
									);
								})
								?.contains(band) ?? false,
					};
					probe.remove();
					return result;
				}, id);
				expect(
					paint.exposed,
					`${id} exposed colour width`,
				).toBeGreaterThanOrEqual(3.9);
				expect(paint.visible, `${id} paint is unobscured`).toBe(true);
				expect(paint.actual, `${id} own colour`).toBe(paint.expected);
			}
		},
	},
	{
		name: "assert waiting question animation",
		match: /^the waiting question band visibly breathes$/,
		run: async ({ world }) => {
			const band = world.page.locator(
				'.surface-strip button[data-step-id$="/waiting"]',
			);
			await expect(band).toHaveClass(/live-segment/);
			const pulse = await band.evaluate((node) => {
				const animation = node.getAnimations()[0];
				if (!animation) throw new Error("Waiting band has no animation");
				const running = animation.playState;
				animation.pause();
				animation.currentTime = 0;
				const high = Number(getComputedStyle(node).opacity);
				animation.currentTime = 600;
				const low = Number(getComputedStyle(node).opacity);
				animation.play();
				return { running, high, low };
			});
			expect(pulse.running).toBe("running");
			expect(pulse.high - pulse.low).toBeGreaterThan(0.5);
		},
	},
	{
		name: "assert legible question targets and nearest taps",
		match:
			/^question markers have 24px targets and overlapping taps pick the nearest marker$/,
		run: async ({ world }) => {
			const pins = world.page.getByTestId("turn-hand-back-pin");
			const boxes = await pins.evaluateAll((nodes) =>
				nodes.map((node) => {
					const box = node.getBoundingClientRect();
					const extension = getComputedStyle(node, "::before");
					const extra =
						extension.content !== "none" && extension.content !== "normal";
					return {
						id: node.getAttribute("data-hand-back"),
						x: box.x + box.width / 2,
						y: box.y + box.height / 2,
						width: box.width,
						height: box.height,
						font: Number.parseFloat(getComputedStyle(node).fontSize),
						targetWidth: Math.max(
							box.width,
							extra ? Number.parseFloat(extension.width) : 0,
						),
						targetHeight: Math.max(
							box.height,
							extra ? Number.parseFloat(extension.height) : 0,
						),
					};
				}),
			);
			for (const box of boxes) {
				expect(box.targetWidth, `${box.id} hit width`).toBeGreaterThanOrEqual(
					24,
				);
				expect(box.targetHeight, `${box.id} hit height`).toBeGreaterThanOrEqual(
					24,
				);
				expect(box.width).toBeGreaterThanOrEqual(12);
				expect(box.font).toBeGreaterThanOrEqual(10);
			}
			// Real pointer hit testing above/below the visible face, including both
			// sides of each overlapping target's midpoint. Ties go to the left.
			const taps = boxes.map((box) => ({
				...box,
				tapX: box.x,
				tapY: box.y + 10,
			}));
			for (let i = 1; i < boxes.length; i++) {
				const left = boxes[i - 1];
				const right = boxes[i];
				if (!left || !right || right.x - left.x >= 24) continue;
				const middle = (left.x + right.x) / 2;
				taps.push(
					{ ...left, tapX: middle - 0.5, tapY: left.y - 10 },
					{ ...right, tapX: middle + 0.5, tapY: right.y - 10 },
				);
			}
			for (const [index, tap] of taps.entries()) {
				const current = await world.page
					.locator(`[data-hand-back="${tap.id}"]`)
					.boundingBox();
				if (!current) throw new Error(`Missing marker ${tap.id}`);
				const point = {
					x: current.x + current.width / 2 + tap.tapX - tap.x,
					y: current.y + current.height / 2 + tap.tapY - tap.y,
				};
				if (index % 2 === 0) await world.page.mouse.click(point.x, point.y);
				else
					await world.page.evaluate(({ x, y }) => {
						const target = document.elementFromPoint(x, y);
						if (!target) throw new Error("Missing touch target");
						for (const type of ["pointerdown", "pointerup"])
							target.dispatchEvent(
								new PointerEvent(type, {
									bubbles: true,
									cancelable: true,
									pointerType: "touch",
									pointerId: 1,
									isPrimary: true,
									button: 0,
									clientX: x,
									clientY: y,
								}),
							);
					}, point);
				await expect(
					world.page.locator(`[data-qa-entry="${tap.id}"]`),
				).toBeFocused();
				await world.page.getByTestId("surfacing-minimise-toggle").click();
				await expect(
					world.page.getByTestId("surfacing-minimise-toggle"),
				).toHaveAttribute("aria-expanded", "false");
			}
		},
	},
	{
		name: "assert whole-turn compacted strip numbering and navigation",
		match:
			/^strip popovers and band jumps match every step of the compacted turn log$/,
		run: async ({ world }) => {
			const bands = world.page.locator(".surface-strip button[data-step-id]");
			const ids = await bands.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-step-id")),
			);
			const toggle = world.page.getByTestId("surfacing-minimise-toggle");
			await toggle.click();
			if (await world.page.getByTestId("surfacing-level").count())
				await chooseShowStop(world.page, "Full log");
			const rows = world.page.locator(
				".step-log [data-log-part]:not(:has(.compaction-rule))",
			);
			await expect(rows).toHaveCount(ids.length);
			expect(
				await rows.evaluateAll((nodes) =>
					nodes.map((node) => node.getAttribute("data-log-part")),
				),
			).toEqual(ids);
			await toggle.click();
			// Every work popover keeps the whole-log ordinal on both sides of
			// compaction and hand-back boundaries, including the final batch.
			for (const [index, id] of ids.entries()) {
				if (id?.includes("question-") || id?.match(/band-\d+-0$/)) continue;
				const box = await bands.nth(index).boundingBox();
				if (!box) throw new Error(`Missing band ${id}`);
				await world.page.mouse.move(
					box.x + box.width / 2,
					box.y + box.height / 2,
				);
				await expect(world.page.getByTestId("turn-step-popover")).toContainText(
					`Step ${index + 1} of ${ids.length}`,
				);
			}
			for (const id of [
				"bands-agent/band-0-8",
				"bands-agent/band-0-11",
				...(ids.length === 90
					? ["bands-agent/band-3-8", "bands-agent/band-6-32"]
					: []),
			]) {
				await world.page.mouse.move(0, 0);
				const box = await world.page
					.locator(`.surface-strip button[data-step-id="${id}"]`)
					.boundingBox();
				if (!box) throw new Error(`Missing band ${id}`);
				await world.page.mouse.click(
					box.x + box.width / 2,
					box.y + box.height / 2,
				);
				const row = world.page.locator(`[data-log-part="${id}"]`);
				await expect(row).toBeFocused();
				await expect(row).toBeInViewport();
				await toggle.click();
			}
		},
	},
	{
		name: "seed realistic strip bands",
		match:
			/^the strip session has a (multi|single|sparse)-segment (live|settled) turn at 390 pixels$/,
		run: async ({ world, match }) => {
			await world.page.clock.setFixedTime(PINNED_CLOCK_MS);
			await world.page.setViewportSize({ width: 390, height: 852 });
			const live = match[2] === "live";
			const sparse = match[1] === "sparse";
			const groups = sparse ? 2 : match[1] === "multi" ? 7 : 1;
			const parts: Part[] = [];
			for (let group = 0; group < groups; group++) {
				// Three consecutive questions reproduce the overlapping pin cluster.
				const count = sparse
					? 1
					: groups === 1
						? 12
						: ([12, 12, 12, 12, 0, 0, 36][group] ?? 0);
				for (let index = 0; index < count; index++) {
					if (groups === 1 && index === 10)
						parts.push({
							id: "compact-single",
							type: "compaction",
							text: "Context compacted.",
							time: { start: START + 9500 },
						});
					const id = `band-${group}-${index}`;
					const start = START + group * 160_000 + index * 1000;
					const running = live && group === groups - 1 && index >= count - 2;
					const time = {
						start,
						...(running ? {} : { end: start + (index === 8 ? 20_000 : 30) }),
					};
					if (index === 0 && !sparse)
						parts.push({
							id,
							type: "text",
							text: `Checking batch ${group + 1}.`,
							time,
							surfacingOrdinal: group + 1,
							surfacingProbabilities: { finding: 1 },
						});
					else if (index % 12 === 1 || index % 12 === 11)
						parts.push({
							id,
							type: "reasoning",
							text: "Consider the route dependencies.",
							time,
							...(running ? { state: { status: "running" } } : {}),
						});
					else {
						const tool =
							["Read", "Edit", "Bash", "WebFetch", "Task", "CustomTool"][
								index % 6
							] ?? "Read";
						parts.push({
							id,
							type: "tool",
							tool,
							callID: id,
							time,
							state: {
								status: running
									? "running"
									: index === 9
										? "error"
										: "completed",
								input: {
									_tag: "whole",
									value: {
										file_path: "src/router.ts",
										command: "git diff",
										description: "Inspect routes",
									},
								},
								...(running
									? {}
									: { output: { _tag: "whole", text: "Checked routes." } }),
							},
						});
					}
				}
				if (group === 2 || group === 4)
					parts.push({
						id: `compact-${group}`,
						type: "compaction",
						text: "Context compacted.",
						time: { start: START + group * 160_000 + 12_000 },
					});
				if (group < groups - 1)
					parts.push({
						id: `question-${group}`,
						type: "tool",
						tool: "AskUserQuestion",
						callID: `question-${group}`,
						time: {
							start: START + group * 160_000 + 13_000,
							end: START + (group + 1) * 160_000 - 1000,
						},
						state: {
							status: "completed",
							input: {
								_tag: "whole",
								value: {
									questions: [
										{
											header: "Continue",
											question: "Continue with this batch?",
											options: [{ label: "Continue", description: "Proceed." }],
											multiSelect: false,
										},
									],
								},
							},
							output: { _tag: "whole", text: "Continue" },
						},
					});
			}
			if (!live)
				parts.push({
					id: "reply",
					type: "text",
					text: "The route changes are ready.",
					time: { start: PINNED_CLOCK_MS - 1000, end: PINNED_CLOCK_MS },
				});
			requireRpcControl(world.page).setDetailRows(SESSION, [
				...detailRowsOf({
					id: "bands-user",
					role: "user",
					time: { created: START },
					parts: [
						{
							id: "prompt",
							type: "text",
							text: "Review the routing changes in batches.",
						},
					],
				}),
				...detailRowsOf({
					id: "bands-agent",
					role: "assistant",
					parentID: "bands-user",
					time: {
						created: START + 1,
						...(live ? {} : { completed: PINNED_CLOCK_MS }),
					},
					parts,
				}),
			]);
			setSessionRowStatus(world.page, SESSION, live ? "busy" : "idle", {
				title: "Strip bands",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
			await expect(world.page.locator("#messages .turn-activity")).toHaveCount(
				1,
			);
			await expect(
				world.page.locator("#messages .turn-activity"),
			).toHaveAttribute("data-turn-id", "bands-user/user");
			await expect(
				world.page.getByTestId("surfacing-minimise-toggle"),
			).toContainText(live ? "Working" : "Worked");
			await expect(
				world.page.locator(".surface-strip button[data-step-id]"),
			).toHaveCount(sparse ? 3 : groups === 7 ? 90 : 12);
			await expect(world.page.getByTestId("turn-hand-back-pin")).toHaveCount(
				sparse ? 1 : groups === 7 ? 6 : 0,
			);
			await expect(
				world.page.locator(".surface-strip span[data-step-id]"),
			).toHaveCount(sparse ? 0 : groups === 7 ? 2 : 1);
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
			await expect(
				world.page.locator(".surface-strip .live-segment"),
			).toHaveCount(live ? 2 : 0);
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "record strip evidence without updating baselines",
		match:
			/^I record the (multi|single|sparse)-segment (live|settled) strip with Jev (inactive|active)$/,
		run: async ({ world, match }) => {
			const dir = `test-results/strip-colours/${process.env["STRIP_EVIDENCE"] ?? "current"}`;
			await mkdir(dir, { recursive: true });
			const path = `${dir}/${match[1]}-${match[2]}-${match[3]}`;
			await world.page.screenshot({ path: `${path}.png` });
			world.artifacts.push(`${path}.png`);
			const metrics = await world.page
				.locator(".surface-strip")
				.evaluate((strip) => ({
					track: strip.getBoundingClientRect().width,
					steps: [
						...strip.querySelectorAll<HTMLElement>("button[data-step-id]"),
					].map((node) => ({
						id: node.dataset["stepId"],
						width: node.getBoundingClientRect().width,
						left: node.getBoundingClientRect().left,
						colour: getComputedStyle(node).backgroundColor,
						classes: node.className,
					})),
					pins: [
						...strip.querySelectorAll<HTMLElement>("[data-hand-back]"),
					].map((node) => ({
						width: node.getBoundingClientRect().width,
						left: node.getBoundingClientRect().left,
					})),
				}));
			await writeFile(`${path}.json`, JSON.stringify(metrics, null, 2));
		},
	},
	{
		name: "assert visible kind-coloured bands and compact markers",
		match:
			/^every strip step is a coloured band with compressed waits and non-overlapping markers$/,
		run: async ({ world }) => {
			const strip = world.page.locator(".surface-strip");
			for (const question of await strip
				.locator('button[data-step-id*="/question-"]')
				.all()) {
				const box = await question.boundingBox();
				expect(
					box?.width,
					"Human waiting time must stay in a marker-sized slot",
				).toBeLessThanOrEqual(18.1);
			}
			const geometry = await strip.evaluate((element) => {
				const nodes = [
					...element.querySelectorAll<HTMLElement>("button[data-step-id]"),
				];
				return nodes.map((node) => {
					const box = node.getBoundingClientRect();
					return {
						id: node.dataset["stepId"],
						width: box.width,
						left: box.left,
						right: box.right,
					};
				});
			});
			for (const step of geometry)
				expect(step.width, `${step.id} must be a band`).toBeGreaterThanOrEqual(
					1.95,
				);
			for (const [index, step] of geometry.entries()) {
				const previous = geometry[index - 1];
				if (previous) {
					expect(
						step.left - previous.right,
						`${step.id} gap`,
					).toBeGreaterThanOrEqual(-0.05);
					expect(
						step.left - previous.right,
						`${step.id} gap`,
					).toBeLessThanOrEqual(6.1);
				}
			}
			// Expected paint comes from the fixture's kinds, not the production mapper.
			for (const node of await strip.locator("button[data-step-id]").all()) {
				const id = (await node.getAttribute("data-step-id")) ?? "";
				const index = Number(id.split("-").at(-1));
				const running = (await node.getAttribute("class"))?.includes(
					"live-segment",
				);
				const sparse = geometry.length === 3;
				const token = running
					? "accent"
					: id.includes("question-")
						? "act-other"
						: index === 0 && !sparse
							? "act-text"
							: index % 12 === 1 || index % 12 === 11
								? "act-thinking"
								: index === 9
									? "seg-fail"
									: [
											"act-explore",
											"seg-edit",
											"act-shell",
											"act-fetch",
											"act-task",
											"act-other",
										][index % 6];
				const paint = await node.evaluate((element, colour) => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = `var(--color-${colour})`;
					element.append(probe);
					const values = {
						actual: getComputedStyle(element).backgroundColor,
						expected: getComputedStyle(probe).backgroundColor,
					};
					probe.remove();
					return values;
				}, token);
				expect(paint.actual, id).toBe(paint.expected);
				expect(paint.actual, id).not.toBe("rgba(0, 0, 0, 0)");
			}
			const pins = await strip
				.getByTestId("turn-hand-back-pin")
				.evaluateAll((nodes) =>
					nodes.map((node) => {
						const box = node.getBoundingClientRect();
						return {
							left: box.left,
							right: box.right,
							width: box.width,
							height: box.height,
						};
					}),
				);
			for (const [index, pin] of pins.entries()) {
				expect(pin.height).toBe(12);
				expect(pin.width).toBe(12);
				const previous = pins[index - 1];
				if (previous)
					expect(pin.left - previous.right).toBeGreaterThanOrEqual(2);
			}
		},
	},
];
