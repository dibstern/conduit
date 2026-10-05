import { createSubscriber } from "svelte/reactivity";

let now = Date.now();
const subscribe = createSubscriber((update) => {
	now = Date.now();
	const timer = setInterval(() => {
		now = Date.now();
		update();
	}, 1000);
	return () => clearInterval(timer);
});

export const clock = {
	get now(): number {
		subscribe();
		return now;
	},
};
