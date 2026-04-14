// test/unit/provider/deferred.test.ts
import { describe, expect, it } from "vitest";
import {
	createDeferred,
	type Deferred,
} from "../../../src/lib/provider/deferred.js";

describe("Deferred", () => {
	it("resolve settles the promise with the given value", async () => {
		const d = createDeferred<string>();
		d.resolve("hello");
		await expect(d.promise).resolves.toBe("hello");
	});

	it("reject settles the promise with the given error", async () => {
		const d = createDeferred<string>();
		d.reject(new Error("boom"));
		await expect(d.promise).rejects.toThrow("boom");
	});

	it("promise is pending until resolve is called", async () => {
		const d = createDeferred<number>();
		let settled = false;
		d.promise.then(() => {
			settled = true;
		});
		// Not settled yet (microtask hasn't run)
		expect(settled).toBe(false);
		d.resolve(42);
		await d.promise;
		expect(settled).toBe(true);
	});

	it("double resolve is safe (first wins)", async () => {
		const d = createDeferred<string>();
		d.resolve("first");
		d.resolve("second");
		await expect(d.promise).resolves.toBe("first");
	});

	it("resolve after reject is safe (first wins)", async () => {
		const d = createDeferred<string>();
		d.reject(new Error("fail"));
		d.resolve("too late");
		await expect(d.promise).rejects.toThrow("fail");
	});

	it("returned object has correct shape", () => {
		const d = createDeferred<boolean>();
		expect(d).toHaveProperty("promise");
		expect(d).toHaveProperty("resolve");
		expect(d).toHaveProperty("reject");
		expect(d.promise).toBeInstanceOf(Promise);
		expect(typeof d.resolve).toBe("function");
		expect(typeof d.reject).toBe("function");
	});
});
