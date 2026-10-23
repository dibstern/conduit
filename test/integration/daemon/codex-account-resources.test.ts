// Failure modes: account removal leaves a native login or usage probe alive,
// late login callbacks survive removal, or invalidation closes another account.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

for (const operation of ["login", "usage"] as const) {
	it(`removing a Codex account closes its pending ${operation} before replying`, async () => {
		const artifact = resolve(
			`test-results/codex-account-resources/${operation}`,
		);
		mkdirSync(artifact, { recursive: true });
		const reportPath = join(artifact, "reports.jsonl");
		writeFileSync(reportPath, "");
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const mapPath = join(fixture.root, "traces.json");
		const traces: Record<
			string,
			Record<string, { trace: string; capture: string }>
		> = {};
		const trace = (home: string, scenario: string, source: TraceRow[]) => {
			const selected = (traces[home] ??= {});
			const name = `${Object.keys(traces).indexOf(home)}-${scenario}`;
			const path = join(artifact, `${name}.jsonl`);
			const capture = join(artifact, `${name}-capture.jsonl`);
			writeFileSync(
				path,
				`${source.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
			writeFileSync(capture, "");
			selected[scenario] = { trace: path, capture };
			writeFileSync(mapPath, JSON.stringify(traces));
			return capture;
		};
		trace("*", "codex-discovery", signedInCodexDiscoveryTrace());
		const discovery = signedInCodexDiscoveryTrace();
		const auth = discovery.slice(
			0,
			discovery.findIndex(({ message }) => message?.method === "model/list"),
		);
		trace("*", "codex-discovery-auth", auth);
		trace("*", "codex-auth", auth);
		trace("*", "codex-usage", fixtureRows("usage-read"));
		let passed = false;
		try {
			await fixture.restart({
				startupTimeoutMs: 90_000,
				logFile: join(artifact, "daemon.log"),
				serviceEnvironment: {
					CONDUIT_TEST_CODEX_TRACE_MAP: mapPath,
					CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				},
			});
			const add = async (name: string) => {
				const { addedInstanceId } = await fixture.requestRpc({
					_tag: "AddInstance",
					name,
					driver: "codex",
				});
				assert(addedInstanceId);
				return {
					id: addedInstanceId,
					home: join(
						fixture.configDir,
						"codex",
						"accounts",
						encodeURIComponent(addedInstanceId),
					),
				};
			};
			const removed = await add("Removed");
			const retained = await add("Retained");
			let pending: Promise<unknown> | undefined;
			let capture: string;
			if (operation === "login") {
				capture = trace(
					removed.home,
					"codex-login",
					fixtureRows("login-cancel"),
				);
				trace(retained.home, "codex-login", fixtureRows("login-cancel"));
				for (const account of [removed, retained]) {
					expect(
						await fixture.requestRpc({
							_tag: "StartCodexLogin",
							accountId: account.id,
							method: "browser",
						}),
					).toMatchObject({ login: { state: "pending" } });
				}
			} else {
				const source = fixtureRows("usage-read");
				const response = source.find(
					({ message }) => message?.result?.["rateLimits"],
				);
				assert(response);
				source[0] = { ...source[0], scenario: "removed-usage" };
				// Withhold the response, leaving the native request pending until close.
				capture = trace(
					removed.home,
					"codex-usage",
					source.slice(0, source.indexOf(response)),
				);
				pending = fixture.requestRpc({
					_tag: "QuotaForAccounts",
					projectSlug: "process-test",
				});
				void pending.catch(() => undefined);
				await vi.waitFor(() =>
					expect(
						rows<TraceRow>(capture).some(
							({ message }) => message?.method === "account/rateLimits/read",
						),
					).toBe(true),
				);
			}
			await fixture.requestRpc({
				_tag: "RemoveInstance",
				instanceId: removed.id,
			});
			if (operation === "login") {
				expect(
					rows<TraceRow>(capture).some(
						({ message }) => message?.method === "account/login/cancel",
					),
				).toBe(true);
				expect(
					await fixture.requestRpc({
						_tag: "GetCodexAuth",
						accountId: retained.id,
					}),
				).toMatchObject({ login: { state: "pending" } });
				await fixture.requestRpc({
					_tag: "CancelCodexLogin",
					accountId: retained.id,
				});
			} else {
				expect(
					rows<AppServerTraceReport>(reportPath).find(
						({ scenario }) => scenario === "removed-usage",
					),
				).toMatchObject({ consumed: 7, total: 7, mismatches: [] });
				await pending;
				expect(
					await fixture.requestRpc({
						_tag: "GetCodexAuth",
						accountId: retained.id,
					}),
				).toMatchObject({ status: "logged-in" });
			}
			await expect(
				fixture.requestRpc({ _tag: "GetCodexAuth", accountId: removed.id }),
			).rejects.toThrow();
			passed = true;
		} finally {
			await fixture.dispose();
			writeFileSync(
				join(artifact, "evidence.json"),
				JSON.stringify(
					{
						passed,
						reports: rows<AppServerTraceReport>(reportPath),
						proof: fixture.proof(),
						traces,
					},
					null,
					2,
				),
			);
			expect(fixture.remainingRunnerPids()).toEqual([]);
			expect(
				rows<AppServerTraceReport>(reportPath).flatMap(
					({ mismatches }) => mismatches,
				),
			).toEqual([]);
		}
	}, 90_000);
}
