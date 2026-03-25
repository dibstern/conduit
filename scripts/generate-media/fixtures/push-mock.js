// Mock Notification API so requestPermission() succeeds in headless Chromium.
// Mock PushManager.subscribe to return a fake subscription.
// This file is injected via page.addInitScript({ path: ... }) to avoid
// bundler transformations that break in the browser context.
//
// biome-ignore-all lint/complexity/useArrowFunction: raw JS for browser injection — function expressions are intentional to avoid bundler transforms
// biome-ignore-all lint/complexity/useOptionalChain: raw JS for browser injection — optional chaining not used for clarity

(function () {
	var _perm = "default";

	Object.defineProperty(window, "Notification", {
		value: {
			get permission() {
				return _perm;
			},
			requestPermission: function () {
				_perm = "granted";
				return Promise.resolve("granted");
			},
		},
		writable: true,
		configurable: true,
	});

	// Patch pushManager.subscribe on any service worker registration
	var origRegister =
		navigator.serviceWorker && navigator.serviceWorker.register;
	if (origRegister) {
		navigator.serviceWorker.register = function () {
			return (
				origRegister
					// biome-ignore lint/complexity/noArguments: must forward arguments from function()
					.apply(navigator.serviceWorker, arguments)
					.then(function (reg) {
						reg.pushManager.subscribe = function () {
							return Promise.resolve({
								endpoint: "https://mock.push/endpoint",
								expirationTime: null,
								options: {
									userVisibleOnly: true,
									applicationServerKey: new ArrayBuffer(65),
								},
								getKey: function () {
									return new ArrayBuffer(0);
								},
								unsubscribe: function () {
									return Promise.resolve(true);
								},
								toJSON: function () {
									return {
										endpoint: "https://mock.push/endpoint",
										keys: { p256dh: "mock", auth: "mock" },
									};
								},
							});
						};
						return reg;
					})
			);
		};
	}
})();
