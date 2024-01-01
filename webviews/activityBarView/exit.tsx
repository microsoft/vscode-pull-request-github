/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

const ExitButton = ({ repositoryDefaultBranch, isBusy, onClick }: { repositoryDefaultBranch: string, isBusy: boolean, onClick: () => Promise<void> }) => {
	return (<button title="Switch to a different branch than this pull request branch" disabled={isBusy} onClick={onClick}>
		Checkout '{repositoryDefaultBranch}'
	</button>);
};

const ExitLink = ({ repositoryDefaultBranch, onClick }: { repositoryDefaultBranch: string, onClick: () => Promise<void> }) => {
	return (
		<span>
			<a title="Switch to a different branch than this pull request branch" onClick={onClick}>Checkout '{repositoryDefaultBranch}' </a>without deleting branch
		</span>
	);
};

export const ExitSection = ({ pr }: { pr: PullRequest }) => {
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

	return (
		<div className="button-container">
			{
				pr.state === GithubItemStateEnum.Open ?
					<ExitButton repositoryDefaultBranch={pr.repositoryDefaultBranch} isBusy={isBusy} onClick={onClick} />
					: <ExitLink repositoryDefaultBranch={pr.repositoryDefaultBranch} onClick={onClick} />
			}
		</div>
	);
};