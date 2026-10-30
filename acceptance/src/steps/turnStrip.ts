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

type Part = typeof HistoryMessagePartSchema.Type;
const SESSION = "sess-strip-bands";
const START = PINNED_CLOCK_MS - 1_166_000;

export const turnStripHandlers: StepHandler[] = [
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
				).toBeLessThanOrEqual(12);
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
				expect(pin.height).toBeLessThanOrEqual(8);
				expect(pin.width).toBeLessThanOrEqual(8);
				const previous = pins[index - 1];
				if (previous)
					expect(pin.left - previous.right).toBeGreaterThanOrEqual(2);
			}
		},
	},
];
