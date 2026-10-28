/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { arrowUpIcon, closeIcon, layersIcon } from './icon';
import { StackEntryList } from './pullRequestStack';
import { PullRequestStackRecommendation } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

export const STACKS_DOCUMENTATION_URL = 'https://docs.github.com/en/pull-requests/reference/stacked-pull-requests';
export const STACK_RECOMMENDATION_HINT_LABEL = 'Scroll up to the stack recommendation';

/**
 * Recommends stacking this pull request with the open pull requests whose branches line up with it.
 * @param title The page's title, which stays where it is when the recommendation is added above it.
 */
export const StackRecommendationBanner = ({ pr, title }: { pr: PullRequest; title: React.RefObject<HTMLElement | null> }) => {
	// A recommendation that is found after the page is shown is added above what is being read.
	const pageShown = React.useRef(false);
	React.useEffect(() => { pageShown.current = true; }, []);
	// The recommendation is gone once the pull requests are stacked, so a later one starts out collapsed.
	return pr.stackRecommendation
		? <StackRecommendationContent recommendation={pr.stackRecommendation} currentNumber={pr.number} title={title} pageShown={pageShown} />
		: null;
};

const StackRecommendationContent = ({ recommendation, currentNumber, title, pageShown }: {
	recommendation: PullRequestStackRecommendation;
	currentNumber: number;
	title: React.RefObject<HTMLElement | null>;
	pageShown: React.RefObject<boolean>;
}) => {
	const { createRecommendedStack, dismissStackRecommendation } = React.useContext(PullRequestContext);
	const [previewing, setPreviewing] = React.useState(false);
	const [creating, setCreating] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	const mounted = React.useRef(true);
	React.useEffect(() => () => { mounted.current = false; }, []);
	const section = React.useRef<HTMLElement>(null);
	// Where the title was before the recommendation was added above it: `undefined` until that is read, and `null` when
	// the recommendation is shown with the page, so that there is nothing to keep in place.
	const [titleBeforeAdded, setTitleBeforeAdded] = React.useState<DOMRect | null>();
	// How far adding the recommendation pushed the title down, and where the page was then scrolled to.
	const keptInPlace = React.useRef<{ pushedDown: number; scrollTop: number }>();
	const [hintDismissed, setHintDismissed] = React.useState(false);
	// The hint is for a recommendation that appears just above what is being read.
	const hinting = !hintDismissed && !!titleBeforeAdded && titleBeforeAdded.bottom > 0;
	const { stack, existingStackSize } = recommendation;
	const extending = existingStackSize !== undefined;
	const adding = stack.size - (existingStackSize ?? 0);

	// The recommendation first renders nothing, so that this reads where the title is before the recommendation is added.
	// Updating the state here renders the recommendation before the page is painted.
	React.useLayoutEffect(() => {
		setTitleBeforeAdded(pageShown.current ? title.current?.getBoundingClientRect() ?? null : null);
	}, [pageShown, title]);

	// Keeps what is being read where it is, with the recommendation scrolled out of view above it.
	React.useLayoutEffect(() => {
		if (!titleBeforeAdded || !title.current) {
			return;
		}
		// React may run this again, which does not move the page again.
		const kept = keptInPlace.current;
		const pushedDown = kept?.pushedDown ?? Math.max(0, title.current.getBoundingClientRect().top - titleBeforeAdded.top);
		const root = document.documentElement;
		if (pushedDown > 0) {
			// A page that is shorter than the window needs room to scroll the recommendation out of view.
			root.style.minHeight = `calc(100vh + ${pushedDown}px)`;
			if (!kept) {
				window.scrollTo(window.scrollX, window.scrollY + pushedDown);
			}
		}
		keptInPlace.current = kept ?? { pushedDown, scrollTop: window.scrollY };
		return () => { root.style.minHeight = ''; };
	}, [title, titleBeforeAdded]);

	// Any scrolling after the page was kept in place hides the hint. The scroll event for keeping it in place comes
	// later, and does not change where the page is scrolled to.
	React.useEffect(() => {
		const scrollTop = keptInPlace.current?.scrollTop;
		if (!hinting || scrollTop === undefined) {
			return;
		}
		const dismissHintIfScrolled = () => {
			if (window.scrollY !== scrollTop) {
				setHintDismissed(true);
			}
		};
		// The page can be scrolled after it is painted, before this runs.
		dismissHintIfScrolled();
		window.addEventListener('scroll', dismissHintIfScrolled, { passive: true });
		return () => window.removeEventListener('scroll', dismissHintIfScrolled);
	}, [hinting]);

	const reveal = () => {
		setHintDismissed(true);
		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
		// The hint goes away, so focus moves to what it pointed to.
		section.current?.focus({ preventScroll: true });
	};

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

	if (titleBeforeAdded === undefined) {
		return null;
	}

	return (
		<>
			{hinting ? (
				<button className="stack-recommendation-hint" type="button" title={STACK_RECOMMENDATION_HINT_LABEL} aria-label={STACK_RECOMMENDATION_HINT_LABEL} onClick={reveal}>
					{arrowUpIcon}
					<span>Stack recommendation</span>
				</button>
			) : null}
			<section className="stack-recommendation" aria-label="Stack recommendation" ref={section} tabIndex={-1}>
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
		</>
	);
};
