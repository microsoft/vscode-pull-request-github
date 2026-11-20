/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

/**
 * useState, but track the value of a prop.
 *
 * When the prop value changes, the tracked state will be updated to match.
 *
 * @param prop S the prop to track
 */
export function useStateProp<S>(prop: S): [S, Dispatch<SetStateAction<S>>] {
	const [state, setState] = useState(prop);
	useEffect(() => {
		if (state !== prop) {
			setState(prop);
		}
	}, [prop]);
	return [state, setState];
}

/**
 * Whether the component is still mounted. State can't be updated once it isn't, which an asynchronous action that the
 * component started can find out only after it is done.
 */
export function useMountedRef(): MutableRefObject<boolean> {
	const mounted = useRef(true);
	useEffect(() => () => {
		mounted.current = false;
	}, []);
	return mounted;
}

/**
 * Tracks which of a control's asynchronous actions is in progress, so that the control can be disabled and say what it
 * is doing. Actions often remove the control that started them, such as deleting a comment, so the progress is only
 * cleared while the component is still mounted.
 *
 * @returns The action in progress, and a function that runs an action and resolves or rejects as it does.
 */
export function usePendingAction<K>(): [K | undefined, <R>(key: K, action: () => Promise<R>) => Promise<R>] {
	const [pending, setPending] = useState<K | undefined>();
	const mounted = useMountedRef();
	const run = useCallback(async <R>(key: K, action: () => Promise<R>): Promise<R> => {
		setPending(key);
		try {
			return await action();
		} finally {
			if (mounted.current) {
				setPending(undefined);
			}
		}
	}, []);
	return [pending, run];
}

/** {@link usePendingAction} for a control with a single action. */
export function useBusyAction(): [boolean, <R>(action: () => Promise<R>) => Promise<R>] {
	const [pending, run] = usePendingAction<true>();
	const runAction = useCallback(<R>(action: () => Promise<R>) => run(true, action), [run]);
	return [!!pending, runAction];
}
