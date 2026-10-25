// Failure modes: losing the existing login, sharing it with another account,
// overwriting a scoped login, re-adopting after logout/default change/restart,
// and moving or changing the legacy file while old runners still read it.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CURRENT_CONFIG_VERSION } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];
afterEach(async ({ task }) => {
	if (!harness) return;
	await harness.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		proof: harness.proof(),
		remainingRunners: harness.remainingRunnerPids(),
	});
	writeFileSync(
		"/tmp/conduit-82tn9-5-auth-upgrade-fixed.json",
		JSON.stringify(scenarios, null, 2),
	);
	harness = undefined;
});

for (const existing of [false, true]) {
	it(`${existing ? "preserves a scoped login instead of adopting" : "adopts the legacy login only for the existing default account"}`, async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const fixture = harness;
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		config["configVersion"] = CURRENT_CONFIG_VERSION;
		const save = (defaultId: string) =>
			writeFileSync(
				configPath,
				JSON.stringify({
					...config,
					instances: [
						{
							id: "cursor-a",
							name: "A",
							driver: "cursor",
							port: 0,
							managed: false,
						},
						{
							id: "cursor-b",
							name: "B",
							driver: "cursor",
							port: 0,
							managed: false,
						},
					],
					accountDefaults: { cursor: defaultId },
				}),
			);
		save("cursor-a");
		const legacy = join(fixture.root, "home", ".cursor", "sdk", "auth.json");
		const credential = (email: string) =>
			JSON.stringify({
				version: 1,
				apiKey: "[REDACTED:legacy]",
				backendUrl: "https://api2.cursor.sh",
				email,
				createdAtMs: Date.now(),
			});
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, credential("legacy@example.test"), { mode: 0o600 });
		const original = readFileSync(legacy, "utf8");
		const scoped = join(
			fixture.configDir,
			"cursor",
			"accounts",
			createHash("sha256").update("cursor-a").digest("hex"),
			"auth.json",
		);
		if (existing) {
			mkdirSync(dirname(scoped), { recursive: true, mode: 0o700 });
			writeFileSync(scoped, credential("scoped@example.test"), { mode: 0o600 });
		}
		const restart = () =>
			fixture.restart({
				startupTimeoutMs: 90_000,
				serviceEnvironment: { CURSOR_API_KEY: "" },
			});
		await restart();
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances.find(
				({ id }) => id === "cursor-a",
			)?.isDefault,
		).toBe(true);
		expect(
			await fixture.requestRpc({
				_tag: "GetCursorAuth",
				accountId: "cursor-a",
			}),
		).toMatchObject({
			status: "logged-in",
			email: existing ? "scoped@example.test" : "legacy@example.test",
		});
		expect(
			await fixture.requestRpc({
				_tag: "GetCursorAuth",
				accountId: "cursor-b",
			}),
		).toMatchObject({ status: "logged-out" });
		expect(statSync(scoped).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(scoped)).mode & 0o777).toBe(0o700);
		expect(readFileSync(legacy, "utf8")).toBe(original);
		await fixture.requestRpc({ _tag: "LogoutCursor", accountId: "cursor-a" });
		expect(existsSync(scoped)).toBe(false);
		await fixture.kill();
		save("cursor-b");
		await restart();
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances.find(
				({ id }) => id === "cursor-b",
			)?.isDefault,
		).toBe(true);
		for (const accountId of ["cursor-a", "cursor-b"])
			expect(
				await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
			).toMatchObject({ status: "logged-out" });
		expect(readFileSync(legacy, "utf8")).toBe(original);
	}, 120_000);
}

it("adopts for the implicit account without giving its login to a newly added account", async () => {
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const legacy = join(fixture.root, "home", ".cursor", "sdk", "auth.json");
	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(
		legacy,
		JSON.stringify({
			version: 1,
			apiKey: "[REDACTED:implicit]",
			backendUrl: "https://api2.cursor.sh",
			email: "implicit@example.test",
			createdAtMs: Date.now(),
		}),
		{ mode: 0o600 },
	);
	const restart = () =>
		fixture.restart({
			startupTimeoutMs: 90_000,
			serviceEnvironment: { CURSOR_API_KEY: "" },
		});
	await restart();
	expect(await fixture.requestRpc({ _tag: "GetCursorAuth" })).toMatchObject({
		status: "logged-in",
		email: "implicit@example.test",
	});
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "New account",
		driver: "cursor",
	});
	if (!accountId) throw new Error("Missing new account");
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
	).toMatchObject({ status: "logged-out" });
	await fixture.kill();
	await restart();
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
	).toMatchObject({ status: "logged-out" });
}, 120_000);

it("retries a failed adoption for its original account after the default changes", async () => {
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const configPath = join(fixture.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
		string,
		unknown
	>;
	config["configVersion"] = CURRENT_CONFIG_VERSION;
	const save = (id: string) =>
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				instances: [
					{
						id: "original",
						name: "Original",
						driver: "cursor",
						port: 0,
						managed: false,
					},
					{
						id: "other",
						name: "Other",
						driver: "cursor",
						port: 0,
						managed: false,
					},
				],
				accountDefaults: { cursor: id },
			}),
		);
	save("original");
	const legacy = join(fixture.root, "home", ".cursor", "sdk", "auth.json");
	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(
		legacy,
		JSON.stringify({
			version: 1,
			apiKey: "[REDACTED:retry]",
			backendUrl: "https://api2.cursor.sh",
			email: "original@example.test",
			createdAtMs: Date.now(),
		}),
		{ mode: 0o600 },
	);
	const scoped = join(
		fixture.configDir,
		"cursor",
		"accounts",
		createHash("sha256").update("original").digest("hex"),
		"auth.json",
	);
	mkdirSync(dirname(scoped), { recursive: true, mode: 0o700 });
	// A bad destination makes startup fail after selecting the adoption owner.
	// Restore it before retrying, while selecting a different default account.
	mkdirSync(scoped);
	try {
		await expect(
			fixture.restart({
				startupTimeoutMs: 10_000,
				serviceEnvironment: { CURSOR_API_KEY: "" },
			}),
		).rejects.toThrow();
		await fixture.kill();
	} finally {
		rmSync(scoped, { recursive: true, force: true });
	}
	save("other");
	await fixture.restart({
		startupTimeoutMs: 90_000,
		serviceEnvironment: { CURSOR_API_KEY: "" },
	});
	expect(
		(await fixture.requestRpc({ _tag: "GetInstances" })).instances.find(
			({ id }) => id === "other",
		)?.isDefault,
	).toBe(true);
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: "original" }),
	).toMatchObject({ status: "logged-in", email: "original@example.test" });
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: "other" }),
	).toMatchObject({ status: "logged-out" });
}, 120_000);
