/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { MergeMethod, MergeMethodsAvailability } from '../../src/github/interface';
import { MergeSelect } from './merge';

export const AutoMerge = ({
	updateState,
	allowAutoMerge,
	defaultMergeMethod,
	mergeMethodsAvailability,
	autoMerge,
	isDraft,
}: {
	updateState: (params: Partial<{ autoMerge: boolean; autoMergeMethod: MergeMethod }>) => void;
	allowAutoMerge?: boolean;
	defaultMergeMethod?: MergeMethod;
	mergeMethodsAvailability?: MergeMethodsAvailability;
	autoMerge?: boolean;
	isDraft?: boolean;
}) => {
	if ((!allowAutoMerge && !autoMerge) || !mergeMethodsAvailability || !defaultMergeMethod) {
		return null;
	}
	const select: React.MutableRefObject<HTMLSelectElement> = React.useRef<HTMLSelectElement>() as React.MutableRefObject<HTMLSelectElement>;

	return (
		<div className="automerge-section">
			<div className="automerge-checkbox-wrapper">
				<input
					id="automerge-checkbox"
					type="checkbox"
					name="automerge"
					checked={autoMerge}
					disabled={!allowAutoMerge || isDraft}
					onChange={() =>
						updateState({ autoMerge: !autoMerge, autoMergeMethod: select.current?.value as MergeMethod })
					}
				></input>
			</div>
			<label htmlFor="automerge-checkbox" className="automerge-checkbox-label">
				Auto-merge
			</label>
			<div className="merge-select-container">
				<MergeSelect
					ref={select}
					defaultMergeMethod={defaultMergeMethod}
					mergeMethodsAvailability={mergeMethodsAvailability}
					onChange={() => {
						updateState({ autoMergeMethod: select.current?.value as MergeMethod });
					}}
				/>
			</div>
		</div>
	);
};
