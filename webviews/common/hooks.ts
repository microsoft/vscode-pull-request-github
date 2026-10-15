/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext, Dispatch, SetStateAction, useContext, useEffect, useState } from 'react';

export const ViewportWidthContext = createContext<number | undefined>(undefined);

export function useMaxViewportWidth(maxWidth: number): boolean {
	const width = useContext(ViewportWidthContext);
	const query = `(max-width: ${maxWidth}px)`;
	const [matches, setMatches] = useState(() => width === undefined ? window.matchMedia(query).matches : width <= maxWidth);
	useEffect(() => {
		if (width !== undefined) {
			return;
		}
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	}, [query, width]);
	return width === undefined ? matches : width <= maxWidth;
}

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
