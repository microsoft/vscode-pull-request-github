/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';

import { AddCommentSimple } from '../components/comment';
import { StatusChecksSection } from '../components/merge';

export const Overview = (pr: PullRequest) => {
	const { exitReviewMode } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	const onClick = async () => {
		try {
			setBusy(true);
			await exitReviewMode();
		} finally {
			setBusy(false);
		}
	};

	return <>
		<div id="main">
			<AddCommentSimple {...pr} />
			<StatusChecksSection pr={pr} isSimple={true} />
			<div className="button-container">
				<button title="Switch to a different branch than this pull request branch" disabled={isBusy} onClick={() => onClick()}>
					Exit Review Mode
				</button>
			</div>
		</div>
	</>;
};

