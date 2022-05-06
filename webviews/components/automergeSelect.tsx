/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { CreateParams } from '../../common/views';
import { MergeMethod } from '../../src/github/interface';
import PullRequestContext from '../common/createContext';
import { MergeSelect } from './merge';

export const AutoMerge = (createParams: CreateParams) => {
	if (!createParams.allowAutoMerge) {
		return null;
	}
	const ctx = React.useContext(PullRequestContext);
	const select = React.useRef<HTMLSelectElement>();

	return <div className="automerge-section">
		<div className="automerge-checkbox-wrapper">
			<input
				id="automerge-checkbox"
				type="checkbox"
				name="automerge"
				checked={createParams.autoMerge}
				onChange={() => ctx.updateState({ autoMerge: !createParams.autoMerge })}
			></input>
		</div>
		<label htmlFor="automerge-checkbox" className="automerge-checkbox-label">Auto-merge</label>
		<div className="merge-select-container">
			<MergeSelect ref={select} defaultMergeMethod={createParams.defaultMergeMethod}
				mergeMethodsAvailability={createParams.mergeMethodsAvailability}
				onChange={() => {
					ctx.updateState({ mergeMethod: select.current.value as MergeMethod });
				}}/>
		</div>
	</div>;
};
