/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { closeIcon, layersIcon } from './icon';
import { StackEntryList } from './pullRequestStack';
import { PullRequestStackRecommendation } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

export const STACKS_DOCUMENTATION_URL = 'https://docs.github.com/en/pull-requests/reference/stacked-pull-requests';

/** Recommends stacking this pull request with the open pull requests whose branches line up with it. */
export const StackRecommendationBanner = ({ pr }: { pr: PullRequest }) =>
	// The recommendation is gone once the pull requests are stacked, so a later one starts out collapsed.
	pr.stackRecommendation ? <StackRecommendationContent recommendation={pr.stackRecommendation} currentNumber={pr.number} /> : null;

const StackRecommendationContent = ({ recommendation, currentNumber }: { recommendation: PullRequestStackRecommendation; currentNumber: number }) => {
	const { createRecommendedStack, dismissStackRecommendation } = React.useContext(PullRequestContext);
	const [previewing, setPreviewing] = React.useState(false);
	const [creating, setCreating] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	const mounted = React.useRef(true);
	React.useEffect(() => () => { mounted.current = false; }, []);
	const { stack, existingStackSize } = recommendation;
	const extending = existingStackSize !== undefined;
	const adding = stack.size - (existingStackSize ?? 0);

	const create = async () => {
		try {
			setCreating(true);
			setError(undefined);
			await createRecommendedStack(stack.pullRequests.map(entry => entry.number));
		} catch (createError) {
			if (mounted.current) {
				setError(`Unable to stack pull requests: ${createError instanceof Error ? createError.message || createError.name : String(createError)}`);
			}
		} finally {
			// Stacking removes the recommendation, which unmounts this component.
			if (mounted.current) {
				setCreating(false);
			}
		}
	};

	return (
		<section className="stack-recommendation" aria-label="Stack recommendation">
			<div className="stack-recommendation-banner">
				{layersIcon}
				<span className="stack-recommendation-message">
					This pull request can be stacked with other pull requests. <a href={STACKS_DOCUMENTATION_URL}>Learn more about stacks</a>
				</span>
				<button className="secondary" type="button" aria-expanded={previewing} aria-controls="stack-recommendation-preview"
					disabled={creating} onClick={() => setPreviewing(open => !open)}>
					{previewing ? 'Hide stack' : 'Preview stack'}
				</button>
				<button className="icon-button" type="button" title="Dismiss" aria-label="Dismiss stack recommendation" disabled={creating}
					onClick={dismissStackRecommendation}>
					{closeIcon}
				</button>
			</div>
			{/* Kept in the DOM while collapsed, so the button always has a region to control. */}
			<div className="stack-recommendation-preview" id="stack-recommendation-preview" hidden={!previewing}>
				<div className="stack-recommendation-preview-header">
					<strong>{extending ? 'Add to stack' : 'New stack'}</strong>
					<span className="stack-description">
						{extending
							? `${adding} pull request${adding === 1 ? '' : 's'} will be added to the top of an existing stack of ${existingStackSize} pull request${existingStackSize === 1 ? '' : 's'}.`
							: `${stack.size} pull requests will be stacked, merging down into ${stack.base}.`}
					</span>
				</div>
				<StackEntryList stack={stack} currentNumber={currentNumber} />
				{error ? <div className="stack-action-error" role="alert">{error}</div> : null}
				<div className="stack-recommendation-actions">
					<button type="button" disabled={creating} onClick={create}>
						{creating ? (extending ? 'Adding...' : 'Creating...') : (extending ? 'Add to stack' : 'Create stack')}
					</button>
				</div>
			</div>
		</section>
	);
};
