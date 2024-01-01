/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function done<T>(promise: Promise<T>): Promise<void> {
	return promise.then<void>(() => undefined);
}

export function throttle<T>(fn: () => Promise<T>): () => Promise<T> {
	let current: Promise<T> | undefined;
	let next: Promise<T> | undefined;

	const trigger = (): Promise<T> => {
		if (next) {
			return next;
		}

		if (current) {
			next = done(current).then(() => {
				next = undefined;
				return trigger();
			});

			return next;
		}

		current = fn();

		const clear = () => (current = undefined);
		done(current).then(clear, clear);

		return current;
	};

	return trigger;
}

export function debounce(fn: () => any, delay: number): () => void {
	let timer: NodeJS.Timeout | undefined;

	return () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => fn(), delay);
	};
}
