/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, {
	ChangeEventHandler,
	useCallback,
	useContext,
	useEffect,
	useReducer,
	useState,
} from 'react';
import { AutoMerge, QueuedToMerge, StackAutoMerge } from './automergeSelect';
import { ContextDropdown } from './contextDropdown';
import { Dropdown } from './dropdown';
import { checkIcon, chevronDownIcon, circleFilledIcon, closeIcon, gitMergeIcon, gitPullRequestDraftIcon, layersIcon, loadingIcon, outputIcon, skipIcon, syncIcon, warningIcon } from './icon';
import { canUpdatePullRequestStack, isStackMembershipKnown, StackActions, StackSection, StackUpdateButton, useStackActions } from './pullRequestStack';
import { Avatar } from './user';
import { EventType, ReviewEvent } from '../../src/common/timelineEvent';
import {
	CheckState,
	getStackMergeAllTarget,
	GithubItemStateEnum,
	hasConflictingStackEntry,
	isStackMergeable,
	MergeMethod,
	PullRequestCheckStatus,
	PullRequestMergeability,
	PullRequestReviewRequirement,
	reviewerId,
	ReviewState,
} from '../../src/github/interface';
import { MergeMethodMenuContext, PullRequest, ReadyForReviewAndMergeContext, ReadyForReviewContext } from '../../src/github/views';
import { SELECT_MERGE_METHOD_EVENT } from '../common/constants';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { useBusyAction, usePendingAction } from '../common/hooks';
import { Reviewer } from '../components/reviewer';

/** How a requirement for merging stands. Each state has its own icon and color, so rows can be told apart at a glance. */
type StatusState = 'success' | 'failure' | 'pending' | 'warning' | 'neutral' | 'info';

const STATUS_ICONS: Record<StatusState, JSX.Element> = {
	success: checkIcon,
	failure: closeIcon,
	pending: circleFilledIcon,
	warning: warningIcon,
	neutral: skipIcon,
	info: syncIcon,
};

const StatusIcon = ({ state }: { state: StatusState }) => <span className={`status-icon ${state}`}>{STATUS_ICONS[state]}</span>;

/** A requirement for merging, which leads with its state and offers the action that helps meet it. */
const StatusRow = ({ state, heading, detail, action, trailing, children }: {
	state: StatusState;
	heading: React.ReactNode;
	detail?: React.ReactNode;
	action?: React.ReactNode;
	/** Shown after the action, outside of its button container, such as a disclosure button. */
	trailing?: React.ReactNode;
	children?: React.ReactNode;
}) => (
	<div className="status-section">
		<div className="status-item">
			<StatusIcon state={state} />
			<div className="status-text">
				<div className="status-heading">{heading}</div>
				{detail ? <div className="status-detail">{detail}</div> : null}
			</div>
			{action ? <div className="button-container">{action}</div> : null}
			{trailing}
		</div>
		{children}
	</div>
);

const BaseBranch = ({ pr }: { pr: PullRequest }) => <code className="branch-tag">{pr.base}</code>;

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const PRStatusMessage = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	return pr.state === GithubItemStateEnum.Merged ? (
		<div className="branch-status-message">
			<div className="branch-status-icon">{isSimple ? gitMergeIcon : null}</div>{' '}
			{'Pull request successfully merged.'}
		</div>
	) : pr.state === GithubItemStateEnum.Closed ? (
		<div className="branch-status-message">{'This pull request is closed.'}</div>
	) : null;
};

const DeleteOption = ({ pr }: { pr: PullRequest }) => {
	return pr.state === GithubItemStateEnum.Open ? null : <DeleteBranch {...pr} />;
};

type CheckCounts = Record<'failure' | 'pending' | 'neutral' | 'success', number>;

function getCheckState(state: CheckState): keyof CheckCounts {
	switch (state) {
		case CheckState.Success:
			return 'success';
		case CheckState.Failure:
			return 'failure';
		case CheckState.Neutral:
			return 'neutral';
	}
	return 'pending';
}

function countChecks(statuses: PullRequestCheckStatus[]): CheckCounts {
	const counts: CheckCounts = { failure: 0, pending: 0, neutral: 0, success: 0 };
	for (const status of statuses) {
		counts[getCheckState(status.state)]++;
	}
	return counts;
}

function getChecksStatus(statuses: PullRequestCheckStatus[]): { state: StatusState; heading: string } {
	const counts = countChecks(statuses);
	if (counts.failure) {
		return { state: 'failure', heading: 'Some checks failed' };
	}
	if (counts.pending) {
		return { state: 'pending', heading: 'Some checks haven\'t completed yet' };
	}
	if (!counts.success) {
		return { state: 'neutral', heading: 'All checks were skipped' };
	}
	return { state: 'success', heading: 'All checks passed' };
}

const CHECK_COUNT_LABELS: [keyof CheckCounts, string][] = [
	['failure', 'failing'],
	['pending', 'pending'],
	['neutral', 'skipped'],
	['success', 'passing'],
];

const CheckCountSummary = ({ statuses }: { statuses: PullRequestCheckStatus[] }) => {
	const counts = countChecks(statuses);
	return (
		<span className="check-counts">
			{CHECK_COUNT_LABELS.filter(([state]) => counts[state]).map(([state, label]) =>
				<span key={state} className="check-count"><StatusIcon state={state} />{counts[state]} {label}</span>
			)}
		</span>
	);
};

const StatusChecks = ({ pr }: { pr: PullRequest }) => {
	const { state, status } = pr;
	const [showDetails, toggleDetails] = useReducer(
		show => !show,
		status?.statuses.some(s => s.state === CheckState.Failure) ?? false,
	) as [boolean, () => void];

	useEffect(() => {
		if (status?.statuses.some(s => s.state === CheckState.Failure) ?? false) {
			if (!showDetails) {
				toggleDetails();
			}
		} else {
			if (showDetails) {
				toggleDetails();
			}
		}
	}, [status?.statuses]);

	if (state !== GithubItemStateEnum.Open || !status?.statuses.length) {
		return null;
	}
	const { state: checksState, heading } = getChecksStatus(status.statuses);
	return (
		<StatusRow
			state={checksState}
			heading={heading}
			// The list of checks shows each check's state, so the counts are only shown while it is hidden.
			detail={showDetails ? undefined : <CheckCountSummary statuses={status.statuses} />}
			trailing={
				<button
					id="status-checks-display-button"
					className="icon-button"
					onClick={toggleDetails}
					aria-expanded={showDetails}
					aria-label={showDetails ? 'Hide status checks' : 'Show status checks'}
					title={showDetails ? 'Hide status checks' : 'Show status checks'}
				>
					{chevronDownIcon}
				</button>
			}
		>
			{showDetails ? <StatusCheckDetails statuses={status.statuses} /> : null}
		</StatusRow>
	);
};

const WorkflowsAwaitingApproval = ({ pr }: { pr: PullRequest }) => {
	const { approveWorkflowRuns } = useContext(PullRequestContext);
	const [isBusy, run] = useBusyAction();
	const workflowRunIds = pr.status?.workflowRunIdsAwaitingApproval;
	if (pr.state !== GithubItemStateEnum.Open || !workflowRunIds?.length) {
		return null;
	}

	const approve = () => run(() => approveWorkflowRuns(workflowRunIds));
	const isPlural = workflowRunIds.length > 1;
	return (
		<StatusRow
			state="warning"
			heading={`${pluralize(workflowRunIds.length, 'workflow')} awaiting approval`}
			detail={isPlural ? 'A maintainer must approve them before they run.' : 'A maintainer must approve it before it runs.'}
			action={pr.hasWritePermission ? <button className="secondary" onClick={approve} disabled={isBusy}>{isBusy ? 'Approving...' : 'Approve Workflows'}</button> : undefined}
		/>
	);
};

function getReviewStatus(requirement: PullRequestReviewRequirement): { state: StatusState; heading: string; detail: string } {
	switch (requirement.state) {
		case CheckState.Failure:
			return {
				state: 'failure',
				heading: 'Review required',
				detail: `Needs approval from at least ${pluralize(requirement.count, 'reviewer')} with write access.`,
			};
		case CheckState.Pending:
			return {
				state: 'failure',
				heading: 'Changes requested',
				detail: `${pluralize(requirement.requestedChanges.length, 'reviewer')} with write access requested changes.`,
			};
	}
	return {
		state: 'success',
		heading: 'Approved',
		detail: `Approved by ${pluralize(requirement.approvals.length, 'reviewer')} with write access.`,
	};
}

const RequiredReviewers = ({ pr }: { pr: PullRequest }) => {
	const { state, reviewRequirement } = pr;
	if (!reviewRequirement || state !== GithubItemStateEnum.Open) {
		return null;
	}
	return <StatusRow {...getReviewStatus(reviewRequirement)} />;
};

const InlineReviewers = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	if (!isSimple || pr.state !== GithubItemStateEnum.Open || pr.reviewers.length === 0) {
		return null;
	}

	// match an event to each reviewer
	// Use events as the outer loop as there are likely to be more events than reviewers
	const reviewInfos: {event: ReviewEvent, reviewState: ReviewState}[] = [];
	const remainingReviewers = new Set(pr.reviewers);
	let eventIndex = pr.events.length - 1;
	while (eventIndex >= 0 && remainingReviewers.size > 0) {
		const event = pr.events[eventIndex];
		if (event.event === EventType.Reviewed) {
			for (const reviewState of remainingReviewers) {
				if (event.user.id === reviewState.reviewer.id) {
					reviewInfos.push({event, reviewState});
					remainingReviewers.delete(reviewState);
					break;
				}
			}
		}
		eventIndex--;
	}

	return  (
			<div className="section">
				{' '}
				{reviewInfos.map(reviewerInfo => {

					return <Reviewer key={reviewerId(reviewerInfo.reviewState.reviewer)} {...reviewerInfo} />;
				})}
			</div>
	);
};

interface BranchStatusInfo {
	state: StatusState;
	heading: React.ReactNode;
	detail?: React.ReactNode;
	/** Updates the branch with a merge commit, which is also how its conflicts are resolved. */
	mergeCommitAction?: string;
	/** Updating the stack brings its branches up to date, which is also how their conflicts are resolved. */
	offerStackUpdate: boolean;
}

function getBranchStatus(pr: PullRequest, isSimple: boolean): BranchStatusInfo {
	const base = <BaseBranch pr={pr} />;
	const canUpdateStack = canUpdatePullRequestStack(pr);
	// Stacked branches are updated by rebasing the whole stack, so they never get merge commits.
	const canMergeCommit = pr.canUpdateBranch && !pr.stack && isStackMembershipKnown(pr) && !pr.stackLoadError;
	if (pr.mergeable === PullRequestMergeability.Conflict) {
		return {
			state: 'failure',
			heading: <>Conflicts with {base}</>,
			detail: 'This branch has conflicts that must be resolved.',
			mergeCommitAction: canMergeCommit ? 'Resolve Conflicts' : undefined,
			offerStackUpdate: canUpdateStack,
		};
	}
	if (hasConflictingStackEntry(pr.stack)) {
		// This branch's own status would contradict the stack's conflicts, which block merging it.
		return {
			state: 'failure',
			heading: 'Conflicts in this stack',
			detail: 'A pull request in this stack has conflicts that must be resolved.',
			offerStackUpdate: canUpdateStack,
		};
	}

	// The editor offers to update the branch whatever its status is. The sidebar only offers it to resolve conflicts.
	const offerStackUpdate = canUpdateStack && !isSimple;
	const offerMergeCommit = canMergeCommit && !isSimple;
	switch (pr.mergeable) {
		case PullRequestMergeability.Behind:
			return {
				state: 'warning',
				heading: 'Branch is out of date',
				detail: <>This branch doesn't have the latest commits from {base}.</>,
				mergeCommitAction: offerMergeCommit ? 'Update with Merge Commit' : undefined,
				offerStackUpdate,
			};
		case PullRequestMergeability.NotMergeable:
			return {
				state: 'failure',
				heading: 'Branch protection rules not met',
				detail: <>The rules for {base} must be met before merging.{offerMergeCommit ? <> This branch is also behind {base}.</> : null}</>,
				mergeCommitAction: offerMergeCommit ? 'Update with Merge Commit' : undefined,
				offerStackUpdate,
			};
		case PullRequestMergeability.Mergeable:
			if (offerMergeCommit) {
				return {
					state: 'info',
					heading: <>Branch is behind {base}</>,
					detail: 'No conflicts, and updating isn\'t required to merge.',
					mergeCommitAction: 'Update with Merge Commit',
					offerStackUpdate: false,
				};
			}
			if (offerStackUpdate) {
				return {
					state: 'info',
					heading: <>No conflicts with {base}</>,
					detail: 'Some pull requests in this stack are behind their bases.',
					offerStackUpdate,
				};
			}
			return { state: 'success', heading: <>No conflicts with {base}</>, offerStackUpdate: false };
	}
	return { state: 'pending', heading: 'Checking for conflicts...', offerStackUpdate };
}

const BranchStatus = ({ pr, isSimple, stackActions }: { pr: PullRequest; isSimple: boolean; stackActions: StackActions }) => {
	const { updateBranch } = useContext(PullRequestContext);
	const [busy, run] = useBusyAction();
	if (pr.state !== GithubItemStateEnum.Open) {
		return null;
	}

	const update = () => run(updateBranch);
	const { state, heading, detail, mergeCommitAction, offerStackUpdate } = getBranchStatus(pr, isSimple);
	const progress = pr.mergeable === PullRequestMergeability.Conflict ? 'Resolving Conflicts...' : 'Updating...';
	const action = offerStackUpdate
		? <StackUpdateButton pr={pr} actions={stackActions} />
		: mergeCommitAction
			? <button className="secondary" onClick={update} disabled={busy}>{busy ? progress : mergeCommitAction}</button>
			: undefined;
	return <StatusRow state={state} heading={heading} detail={detail} action={action} />;
};

type MergeSummaryKind = 'ready' | 'blocked' | 'draft' | 'checking';

/** What keeps an open pull request that is not a draft from being merged, from most to least likely to need the user. */
function getBlockingReasons(pr: PullRequest): string[] {
	const reasons: string[] = [];
	if (pr.reviewRequirement?.state === CheckState.Failure) {
		reasons.push('Review required');
	} else if (pr.reviewRequirement?.state === CheckState.Pending) {
		reasons.push('Changes requested');
	}
	if (pr.status?.workflowRunIdsAwaitingApproval?.length) {
		reasons.push('Workflows awaiting approval');
	}
	const checks = countChecks(pr.status?.statuses ?? []);
	if (checks.failure) {
		reasons.push(`${pluralize(checks.failure, 'check')} failed`);
	}
	if (checks.pending) {
		reasons.push(`${pluralize(checks.pending, 'check')} pending`);
	}
	if (pr.mergeable === PullRequestMergeability.Conflict) {
		reasons.push('Conflicts');
	} else if (hasConflictingStackEntry(pr.stack)) {
		reasons.push('Conflicts in the stack');
	} else if (pr.mergeable === PullRequestMergeability.Behind) {
		reasons.push('Branch out of date');
	}
	const stack = pr.stack;
	const notReadyBelow = stack?.pullRequests.filter(entry => entry.position < stack.position && entry.state !== GithubItemStateEnum.Merged
		&& (entry.state !== GithubItemStateEnum.Open || entry.isDraft || entry.mergeable !== PullRequestMergeability.Mergeable)).length ?? 0;
	if (notReadyBelow) {
		reasons.push(`${pluralize(notReadyBelow, 'pull request')} below can't be merged yet`);
	}
	if (!reasons.length) {
		reasons.push('Branch protection rules not met');
	}
	return reasons;
}

function getMergeSummary(pr: PullRequest): { kind: MergeSummaryKind; title: string; detail?: string } | undefined {
	if (pr.isIssue || pr.state !== GithubItemStateEnum.Open || pr.stackLoadError) {
		return undefined;
	}
	if (pr.isDraft) {
		return { kind: 'draft', title: 'This pull request is still a work in progress', detail: 'Draft pull requests can\'t be merged.' };
	}
	switch (getMergeReadiness(pr)) {
		case 'ready':
			return { kind: 'ready', title: 'Ready to merge', detail: 'All requirements are met.' };
		case 'blocked':
		case 'checks-failed':
			return { kind: 'blocked', title: 'Merging is blocked', detail: getBlockingReasons(pr).join(' · ') };
	}
	return { kind: 'checking', title: 'Checking whether this pull request can be merged...' };
}

const MERGE_SUMMARY_ICONS: Record<MergeSummaryKind, JSX.Element> = {
	ready: checkIcon,
	blocked: closeIcon,
	draft: gitPullRequestDraftIcon,
	checking: circleFilledIcon,
};

/** Answers whether the pull request can be merged, and if not, why, before the details of each requirement. */
const MergeSummary = ({ pr }: { pr: PullRequest }) => {
	const summary = getMergeSummary(pr);
	if (!summary) {
		return null;
	}
	return (
		<div className={`merge-summary ${summary.kind}`}>
			<span className="merge-summary-icon">{MERGE_SUMMARY_ICONS[summary.kind]}</span>
			<div className="merge-summary-text">
				<div className="merge-summary-title">{summary.title}</div>
				{summary.detail ? <div className="merge-summary-detail">{summary.detail}</div> : null}
			</div>
		</div>
	);
};

/** Requirements that are met, summarized on one line so that the ones that need attention stand out. */
const PassingRequirements = ({ labels, expanded, toggle, children }: {
	labels: React.ReactNode[];
	expanded: boolean;
	toggle: () => void;
	children: React.ReactNode;
}) => (
	<div className="passing-requirements">
		{/* Like the stack's header, clicking anywhere in the summary that is not a button toggles the requirements. */}
		<div className="status-item passing-summary" onClick={event => {
			if (!(event.target instanceof Element && event.target.closest('button'))) {
				toggle();
			}
		}}>
			<span className="passing-labels">
				{labels.map((label, index) => <span key={index} className="passing-label"><StatusIcon state="success" />{label}</span>)}
			</span>
			<button className="icon-button passing-chevron" type="button" aria-expanded={expanded} aria-controls="passing-requirements-content"
				aria-label={expanded ? 'Hide requirements that are met' : 'Show requirements that are met'}
				title={expanded ? 'Hide requirements that are met' : 'Show requirements that are met'} onClick={toggle}>
				{chevronDownIcon}
			</button>
		</div>
		<div id="passing-requirements-content" hidden={!expanded}>
			{children}
		</div>
	</div>
);

/** Mergeability that GitHub is still computing is polled until it is known. */
function usePolledMergeability(pr: PullRequest): PullRequestMergeability {
	const { checkMergeability } = useContext(PullRequestContext);
	const [mergeable, setMergeability] = useState(pr.mergeable);
	if ((pr.mergeable !== mergeable) && (pr.mergeable !== PullRequestMergeability.Unknown)) {
		setMergeability(pr.mergeable);
	}

	const isOpen = !pr.isIssue && pr.state === GithubItemStateEnum.Open;
	useEffect(() => {
		if (!isOpen || mergeable !== PullRequestMergeability.Unknown) {
			return;
		}
		const handle = setInterval(async () => {
			const { mergeability: newMergeability } = await checkMergeability();
			setMergeability(newMergeability);
		}, 3000);
		return () => clearInterval(handle);
	}, [mergeable, isOpen]);
	return mergeable;
}

export const StatusChecksSection = ({ pr: initialPullRequest, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	const { create } = useContext(PullRequestContext);
	const stackActions = useStackActions();
	const mergeable = usePolledMergeability(initialPullRequest);
	const [showPassing, setShowPassing] = useState(false);
	if (initialPullRequest.isIssue) {
		return null;
	}

	const pr = mergeable === initialPullRequest.mergeable ? initialPullRequest : { ...initialPullRequest, mergeable };
	const isOpen = pr.state === GithubItemStateEnum.Open;
	const statuses = pr.status?.statuses ?? [];
	const checks = countChecks(statuses);
	const branchStatus = getBranchStatus(pr, isSimple);
	// Once the pull request can be merged, the requirements that it meets are summarized on one line.
	const passing = {
		review: pr.reviewRequirement ? getReviewStatus(pr.reviewRequirement).state === 'success' : false,
		checks: statuses.length ? getChecksStatus(statuses).state === 'success' : false,
		branch: branchStatus.state === 'success',
	};
	const passingLabels = [
		passing.review ? 'Approved' : undefined,
		passing.checks ? `${pluralize(checks.success, 'check')} passed${checks.neutral ? `, ${checks.neutral} skipped` : ''}` : undefined,
		passing.branch ? branchStatus.heading : undefined,
	].filter(label => label !== undefined);
	const collapsePassing = isOpen && getMergeReadiness(pr) === 'ready' && passingLabels.length > 1;
	const show = (requirement: keyof typeof passing) => !collapsePassing || !passing[requirement];

	return (
		<div id="status-checks">
			<PRStatusMessage pr={pr} isSimple={isSimple} />
			<MergeSummary pr={pr} />
			{collapsePassing ? (
				<PassingRequirements labels={passingLabels} expanded={showPassing} toggle={() => setShowPassing(expanded => !expanded)}>
					{passing.review ? <RequiredReviewers pr={pr} /> : null}
					{passing.checks ? <StatusChecks pr={pr} /> : null}
					{passing.branch ? <BranchStatus pr={pr} isSimple={isSimple} stackActions={stackActions} /> : null}
				</PassingRequirements>
			) : null}
			{show('review') ? <RequiredReviewers pr={pr} /> : null}
			<WorkflowsAwaitingApproval pr={pr} />
			{show('checks') ? <StatusChecks pr={pr} /> : null}
			<InlineReviewers pr={pr} isSimple={isSimple} />
			{!isSimple ? <StackSection pr={pr} actions={stackActions} /> : null}
			{/* Below the stack, since updating the stack is offered with the branch's status. */}
			{show('branch') ? <BranchStatus pr={pr} isSimple={isSimple} stackActions={stackActions} /> : null}
			{isOpen && stackActions.updateError ? <div className="stack-action-error" role="alert">{stackActions.updateError}</div> : null}
			{isOpen ? (
				<div className="merge-footer">
					<PrActions pr={pr} isSimple={isSimple} />
				</div>
			) : null}
			{isSimple && !isOpen ? (
				<div className="branch-status-container">
					<form>
						<button type="submit" onClick={create}>Create New Pull Request...</button>
					</form>
				</div>
			) : null}
			<DeleteOption pr={pr} />
		</div>
	);
};

export default StatusChecksSection;

export const ReadyForReview = ({ isCopilotOnMyBehalf, mergeMethod }: { isCopilotOnMyBehalf?: boolean; mergeMethod: MergeMethod }) => {
	const { readyForReview, readyForReviewAndMerge, updatePR, pr } = useContext(PullRequestContext);
	const [isBusy, run] = useBusyAction();

	const markReadyForReview = useCallback(() => run(async () => {
		const result = await readyForReview();
		updatePR(result);
	}), [run, readyForReview, updatePR]);

	const markReadyAndMerge = useCallback(() => run(async () => {
		const result = await readyForReviewAndMerge({ mergeMethod: mergeMethod });
		updatePR(result);
	}), [run, readyForReviewAndMerge, updatePR, mergeMethod]);

	const allOptions = useCallback(() => {
		const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [
			{
				label: 'Ready for Review',
				value: 'ready',
				action: markReadyForReview
			}
		];

		if (isCopilotOnMyBehalf) {
			actions.push({
				label: 'Ready, Approve, and Auto-Merge',
				value: 'readyAndMerge',
				action: markReadyAndMerge
			});
		}

		return actions;
	}, [isCopilotOnMyBehalf, markReadyForReview, markReadyAndMerge]);

	// The merge summary explains that drafts can't be merged, so this only offers to mark it ready.
	return (
		<div className="ready-for-review-container">
			<div className='button-container'>
				<ContextDropdown
					optionsContext={() => {
						if (!pr) {
							throw new Error('PR context is required for ready for review options');
						}
						let ctx: ReadyForReviewContext | ReadyForReviewAndMergeContext = {
							'preventDefaultContextMenuItems': true,
							'github:readyForReviewMenu': true,
							owner: pr.owner,
							repo: pr.repo,
							number: pr.number,
						};
						if (isCopilotOnMyBehalf) {
							ctx = {
								...ctx,
								'github:readyForReviewMenuWithMerge': true,
								mergeMethod,
							};
						}
						return JSON.stringify(ctx);
					}}
					defaultAction={markReadyForReview}
					defaultOptionLabel={() => isBusy ? (
						<>
							<span className='loading-button'>{loadingIcon}</span>
							Marking Ready for Review...
						</>
					) : 'Ready for Review'}
					defaultOptionValue={() => 'ready'}
					allOptions={allOptions}
					optionsTitle='Ready for Review'
					disabled={isBusy || pr?.busy}
					hasSingleAction={!isCopilotOnMyBehalf}
					spreadable={false}
				/>
			</div>
		</div>
	);
};

const MERGE_METHOD_ORDER: MergeMethod[] = ['merge', 'squash', 'rebase'];

/** The merge button's label for each method, which names what the button does rather than the method. */
const MERGE_BUTTON_LABELS: Record<MergeMethod, string> = {
	merge: 'Merge Pull Request',
	squash: 'Squash and Merge',
	rebase: 'Rebase and Merge',
};

/** Adds the pull request to the merge queue of its base branch. */
const EnqueueButton = () => {
	const { enqueue } = useContext(PullRequestContext);
	const [isBusy, run] = useBusyAction();

	return <button onClick={() => run(enqueue)} disabled={isBusy}>{isBusy ? 'Adding to Merge Queue...' : 'Add to Merge Queue'}</button>;
};

export const Merge = (pr: PullRequest) => {
	const [selectedMethod, selectMethod] = useState<MergeMethod | null>(null);

	useEffect(() => {
		const onSelect = (method: MergeMethod) => selectMethod(method);
		emitter.addListener(SELECT_MERGE_METHOD_EVENT, onSelect);
		return () => {
			emitter.removeListener(SELECT_MERGE_METHOD_EVENT, onSelect);
		};
	}, []);

	if (pr.mergeQueueMethod) {
		return (
			<div className="automerge-section merge-actions">
				<EnqueueButton />
			</div>
		);
	}

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	const availableMethods = MERGE_METHOD_ORDER.filter(method => pr.mergeMethodsAvailability[method]);
	const defaultMethod = pr.mergeMethodsAvailability[pr.defaultMergeMethod] ? pr.defaultMergeMethod : availableMethods[0] ?? pr.defaultMergeMethod;
	return (
		<div className="automerge-section merge-actions">
			<ContextDropdown
				optionsContext={() => JSON.stringify({
					'preventDefaultContextMenuItems': true,
					'github:mergeMenu': true,
					'github:mergeMenuMerge': !!pr.mergeMethodsAvailability.merge,
					'github:mergeMenuSquash': !!pr.mergeMethodsAvailability.squash,
					'github:mergeMenuRebase': !!pr.mergeMethodsAvailability.rebase,
					owner: pr.owner,
					repo: pr.repo,
					number: pr.number,
				} satisfies MergeMethodMenuContext)}
				defaultAction={() => selectMethod(defaultMethod)}
				defaultOptionLabel={() => MERGE_BUTTON_LABELS[defaultMethod]}
				defaultOptionValue={() => defaultMethod}
				optionsTitle='Choose Merge Method'
				hasSingleAction={availableMethods.length < 2}
				spreadable={false}
			/>
		</div>
	);
};

export const PrActions = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	const { hasWritePermission, canEdit, isDraft, mergeable, isCopilotOnMyBehalf, defaultMergeMethod } = pr;
	if (pr.stackLoadError) {
		return <div className="merge-footer-message">Unable to load pull request stack details. Refresh to retry merging.</div>;
	}
	if (!isStackMembershipKnown(pr)) {
		return <div className="merge-footer-message">Checking pull request stack membership...</div>;
	}
	if (isDraft) {
		// Only PR author and users with push rights can mark draft as ready for review
		if (!canEdit) {
			return null;
		}

		return <ReadyForReview isCopilotOnMyBehalf={isCopilotOnMyBehalf && !pr.stack} mergeMethod={defaultMergeMethod} />;
	}

	if (pr.stackMergeStatus === 'pending') {
		return <div className="merge-footer-message">Stack merge is still processing on GitHub. Refresh to check its status.</div>;
	}
	if (pr.stackMergeStatus === 'enqueued') {
		return <div className="merge-footer-message">Pull request stack added to the merge queue.</div>;
	}
	if (pr.stack) {
		if (!hasWritePermission || pr.mergeQueueEntry) {
			return null;
		}
		// Merging a stack depends on every pull request in it, which may not be loaded yet.
		if (pr.stackLoaded === false) {
			return <div className="merge-footer-message">Checking whether the stack can be merged...</div>;
		}
		const ready = isReadyToMerge(pr);
		// A pull request that is ready is merged rather than given a new request, but a request that already covers it,
		// which may have been enabled through a pull request above that is not ready, is still shown so it can be disabled.
		const showAutoMerge = !isSimple && (!ready || pr.stackAutoMerge?.enabledThrough !== undefined);
		return <>
			{ready ? <MergeStack pr={pr} /> : null}
			{showAutoMerge ? <StackAutoMerge pr={pr} /> : null}
		</>;
	}

	if (!pr.stack && mergeable === PullRequestMergeability.Mergeable && hasWritePermission && !pr.mergeQueueEntry) {
		return isSimple ? <MergeSimple {...pr} /> : <Merge {...pr} />;
	} else if (!pr.stack && !isSimple && hasWritePermission && !pr.mergeQueueEntry) {
		const ctx = useContext(PullRequestContext);
		return (
			<AutoMerge
				updateState={(params: Partial<{ autoMerge: boolean; autoMergeMethod: MergeMethod }>) => {
					return ctx.updateAutoMerge(params);
				}}
				{...pr}
				baseHasMergeQueue={!!pr.mergeQueueMethod}
				defaultMergeMethod={pr.autoMergeMethod ?? pr.defaultMergeMethod}
			/>
		);
	} else if (pr.mergeQueueEntry) {
		return <QueuedToMerge mergeQueueEntry={pr.mergeQueueEntry} />;
	}

	return null;
};

/** Whether the pull request can be merged now, whether or not the user is allowed to merge it. */
function isReadyToMerge(pr: PullRequest): boolean {
	if (pr.isDraft) {
		return false;
	}
	if (!pr.stack) {
		return pr.mergeable === PullRequestMergeability.Mergeable;
	}
	// The lowest open pull request can be merged while behind the stack's base, as long as it has no conflicts.
	const isBottom = !pr.stack.pullRequests.some(entry => entry.position < pr.stack!.position && entry.state === GithubItemStateEnum.Open);
	return (pr.mergeable === PullRequestMergeability.Mergeable || isBottom && pr.mergeable === PullRequestMergeability.Behind)
		&& isStackMergeable(pr.stack, pr.number);
}

export type MergeReadiness = 'ready' | 'checks-failed' | 'blocked';

/** The pull request as it would be once it is marked ready for review. */
function asReadyForReview(pr: PullRequest): PullRequest {
	return {
		...pr,
		isDraft: false,
		stack: pr.stack && {
			...pr.stack,
			pullRequests: pr.stack.pullRequests.map(entry => entry.number === pr.number ? { ...entry, isDraft: false } : entry),
		},
	};
}

/**
 * Whether an open pull request can be merged and, if it cannot, whether a check failed. Undefined for pull requests
 * that are not open, for drafts that could otherwise be merged, and while it is not known whether it can be merged.
 */
export function getMergeReadiness(pr: PullRequest): MergeReadiness | undefined {
	if (pr.isIssue || pr.state !== GithubItemStateEnum.Open) {
		return undefined;
	}
	if (pr.mergeable === PullRequestMergeability.Unknown || pr.stackLoadError || !isStackMembershipKnown(pr)
		|| (pr.stack && pr.stackLoaded === false)) {
		return undefined;
	}
	// Merging a stack also merges the open pull requests below this one, so it depends on their mergeability too.
	const stack = pr.stack;
	if (stack?.pullRequests.some(entry => entry.position <= stack.position && entry.state === GithubItemStateEnum.Open
		&& entry.mergeable === PullRequestMergeability.Unknown)) {
		return undefined;
	}
	if (isReadyToMerge(pr.isDraft ? asReadyForReview(pr) : pr)) {
		return pr.isDraft ? undefined : 'ready';
	}
	return pr.status?.statuses.some(status => status.state === CheckState.Failure) ? 'checks-failed' : 'blocked';
}

export const MergeStack = ({ pr }: { pr: PullRequest }) => {
	const { mergeStack, updatePR } = useContext(PullRequestContext);
	const [method, setMethod] = useState<MergeMethod>(pr.defaultMergeMethod);
	const [confirming, setConfirming] = useState<'stack' | 'all' | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	if (!pr.stack) {
		throw new Error('A pull request stack is required for stack merge actions.');
	}
	const queue = !!pr.mergeQueueMethod;
	const open = pr.stack.pullRequests.filter(entry => entry.state === GithubItemStateEnum.Open);
	const count = 1 + open.filter(entry => entry.position < pr.stack!.position).length;
	const downstack = count - 1;
	const stackName = count < open.length ? 'Partial Stack' : 'Stack';
	const downstackDescription = `${downstack} open pull request${downstack === 1 ? '' : 's'} below it`;
	// Merging the pull request at the top of the stack also merges every open pull request below it.
	const top = getStackMergeAllTarget(pr.stack, pr.number);
	const actions = {
		stack: {
			label: queue ? `Add ${stackName} to Merge Queue` : `Merge ${stackName} (${count} Pull Request${count === 1 ? '' : 's'})`,
			prompt: queue
				? downstack ? `Add this pull request and ${downstackDescription} to the merge queue?` : 'Add this pull request to the merge queue?'
				: downstack ? `Merge this pull request and ${downstackDescription}?` : 'Merge this pull request?',
			progress: queue ? `Adding ${stackName} to Merge Queue...` : `Merging ${stackName}...`,
			upTo: undefined,
		},
		all: top && {
			label: queue ? 'Add All to Merge Queue' : `Merge All (${open.length} Pull Requests)`,
			// The icon button that offers this has no text, so this names it.
			description: queue
				? `Add all ${open.length} open pull requests in this stack to the merge queue`
				: `Merge all ${open.length} open pull requests in this stack`,
			prompt: queue
				? `Add all ${open.length} open pull requests in this stack to the merge queue?`
				: `Merge all ${open.length} open pull requests in this stack?`,
			progress: queue ? 'Adding All to Merge Queue...' : 'Merging All...',
			upTo: top.number,
		},
	};
	// The stack can change while the user confirms, so a merge that is no longer possible goes back to the choices.
	const confirmed = confirming && actions[confirming];

	const submit = async () => {
		try {
			setBusy(true);
			setError(undefined);
			const result = await (confirmed?.upTo === undefined ? mergeStack(method) : mergeStack(method, confirmed.upTo));
			if (result.status !== 'cancelled') {
				updatePR({
					state: result.state ?? pr.state,
					revertable: result.status === 'merged',
					stackMergeStatus: result.status === 'pending' || result.status === 'enqueued' ? result.status : undefined,
				});
			}
			setConfirming(undefined);
		} catch (mergeError) {
			setError(mergeError instanceof Error ? mergeError.message || mergeError.name : String(mergeError));
		} finally {
			setBusy(false);
		}
	};

	return <div className="automerge-section wrapper stack-merge">
		{confirmed ? <>
			<p>{confirmed.prompt}</p>
			{error ? <p role="alert">Unable to merge stack: {error}</p> : null}
			<button className="secondary" disabled={busy} onClick={() => setConfirming(undefined)}>Cancel</button>
			<button disabled={busy} onClick={submit}>
				{busy ? <span className="loading-button">{loadingIcon}</span> : null}
				{busy ? confirmed.progress : confirmed.label}
			</button>
		</> : <>
			<div className="stack-merge-buttons">
				<button onClick={() => setConfirming('stack')}>{actions.stack.label}</button>
				{actions.all ? <button className="icon-button" type="button" title={actions.all.description} aria-label={actions.all.description}
					onClick={() => setConfirming('all')}>{layersIcon}</button> : null}
			</div>
			{!queue ? <div className="stack-merge-method">
				<span>using method</span>
				<MergeSelect {...pr} onChange={event => setMethod(event.target.value as MergeMethod)} />
			</div> : null}
		</>}
	</div>;
};

export const MergeSimple = (pr: PullRequest) => {
	const { merge, updatePR } = useContext(PullRequestContext);

	if (pr.mergeQueueMethod) {
		return <div className='button-container'>
			<EnqueueButton />
		</div>;
	}

	async function submitAction(selected: MergeMethod): Promise<void> {
		const newContext = await merge({
			title: '',
			description: '',
			method: selected,
		});
		updatePR(newContext);
	}

	const availableOptions = Object.keys(MERGE_METHODS)
		.filter(method => pr.mergeMethodsAvailability[method])
		.reduce((methods, key) => {
			methods[key] = MERGE_METHODS[key];
			return methods;
		}, {});

	return <Dropdown options={availableOptions} defaultOption={pr.defaultMergeMethod} submitAction={submitAction} busyLabel='Merging...' />;
};

export const DeleteBranch = (pr: PullRequest) => {
	const { deleteBranch } = useContext(PullRequestContext);
	const [isBusy, run] = useBusyAction();

	if (pr.isRemoteHeadDeleted !== false && pr.isLocalHeadDeleted !== false) {
		return <div />;
	} else {
		return (
			<div className={`branch-status-container${pr.stack ? ' stacked-delete-branch-container' : ''}`}>
				<form
					onSubmit={event => {
						event.preventDefault();
						return run(deleteBranch);
					}}
				>
					<button disabled={isBusy} className="secondary" type="submit">
						{isBusy ? 'Deleting Branch...' : 'Delete Branch...'}
					</button>
				</form>
			</div>
		);
	}
};

function ConfirmMerge({ pr, method, cancel }: { pr: PullRequest; method: MergeMethod; cancel: () => void }) {
	const { merge, updatePR, changeEmail } = useContext(PullRequestContext);
	const [pending, run] = usePendingAction<'merge' | 'changeEmail'>();
	const isBusy = !!pending;
	const emailForCommit = pr.emailForCommit;
	return (
		<div>
			<form id='merge-comment-form'
				onSubmit={event => {
					event.preventDefault();
					const { title, description }: any = event.target;
					return run('merge', async () => {
						const mergeResult = await merge({
							title: title?.value,
							description: description?.value,
							method,
							email: emailForCommit
						});
						updatePR(mergeResult);
					});
				}}
			>
				{method === 'rebase' ? null : (<input type="text" name="title" defaultValue={getDefaultTitleText(method, pr)} />)}
				{method === 'rebase' ? null : (<textarea name="description" defaultValue={getDefaultDescriptionText(method, pr)} />)}
				{(method === 'rebase' || !emailForCommit) ? null : (
					<div className='commit-association'>
						<span>
							Commit will be associated with <button type='button' className='input-box' title='Change email' aria-label='Change email' disabled={isBusy}
								onClick={() => run('changeEmail', () => changeEmail(emailForCommit))}>
								{pending === 'changeEmail' ? 'Changing email...' : emailForCommit}
							</button>
						</span>
					</div>
				)}
				<div className="form-actions" id={method === 'rebase' ? 'rebase-actions' : ''}>
					<button type="button" className="secondary" disabled={isBusy} onClick={cancel}>Cancel</button>
					<button disabled={isBusy} type="submit" id="confirm-merge">
						{pending === 'merge' ? 'Merging...' : `${method === 'rebase' ? 'Confirm ' : ''}${MERGE_METHODS[method]}`}
					</button>
				</div>
			</form>
		</div>
	);
}

function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return pr.mergeCommitMeta?.title ?? `Merge pull request #${pr.number} from ${pr.qualifiedHead}`;
		case 'squash':
			return pr.squashCommitMeta?.title ?? `${pr.title} (#${pr.number})`;
		default:
			return '';
	}
}

function getDefaultDescriptionText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return pr.mergeCommitMeta?.description ?? pr.title;
		case 'squash':
			return pr.squashCommitMeta?.description ?? '';
		default:
			return '';
	}
}

const MERGE_METHODS = {
	merge: 'Create Merge Commit',
	squash: 'Squash and Merge',
	rebase: 'Rebase and Merge',
};

type MergeSelectProps = Pick<PullRequest, 'mergeMethodsAvailability'> &
	Pick<PullRequest, 'defaultMergeMethod'> & { onChange?: ChangeEventHandler<HTMLSelectElement>, name?: string, title?: string, ariaLabel?: string, disabled?: boolean };

export const MergeSelect = React.forwardRef<HTMLSelectElement, MergeSelectProps>(
	({ defaultMergeMethod, mergeMethodsAvailability: avail, onChange, ariaLabel, name, title, disabled }: MergeSelectProps, ref) => {
		return <select ref={ref} defaultValue={defaultMergeMethod} onChange={onChange} disabled={disabled} aria-label={ariaLabel ?? 'Select merge method'} name={name} title={title}>
			{Object.entries(MERGE_METHODS).map(([method, text]) => (
				<option key={method} value={method} disabled={!avail[method]}>
					{text}
					{!avail[method] ? ' (not enabled)' : null}
				</option>
			))}
		</select>;
	},
);

// State order for sorting status checks: failure first, then pending, unknown, neutral, and success
const CHECK_STATE_ORDER: Record<CheckState, number> = {
	[CheckState.Failure]: 0,
	[CheckState.Pending]: 1,
	[CheckState.Unknown]: 2,
	[CheckState.Neutral]: 3,
	[CheckState.Success]: 4,

};

/** Opens the details of a check in the browser. */
const CheckDetailsLink = ({ url }: { url: string }) => {
	const { openCheckDetails } = useContext(PullRequestContext);
	return <a href={url} title={url} onClick={event => {
		// The webview host opens any anchor with an href and ignores defaultPrevented. It would open a link to this
		// pull request, which checks without details of their own have, in this overview, so the click must not reach it.
		event.preventDefault();
		event.stopPropagation();
		void openCheckDetails(url);
	}}>
		Details
	</a>;
};

/** Opens the logs of a failed check run. */
const ViewCheckLogsButton = ({ status }: { status: PullRequestCheckStatus }) => {
	const { viewCheckLogs } = useContext(PullRequestContext);
	const [isOpening, run] = useBusyAction();
	return (
		<button className="icon-button" title={isOpening ? 'Opening Logs...' : 'View Logs'} disabled={isOpening} onClick={() => run(() => viewCheckLogs(status))}>
			{isOpening ? loadingIcon : outputIcon}
		</button>
	);
};

const StatusCheckDetails = ({ statuses }: { statuses: PullRequestCheckStatus[] }) => {
	// Required checks come first, then each group is ordered by state.
	// Use slice() to avoid mutating the original array
	const sortedStatuses = statuses.slice().sort((a, b) => {
		if (a.isRequired !== b.isRequired) {
			return a.isRequired ? -1 : 1;
		}
		return CHECK_STATE_ORDER[a.state] - CHECK_STATE_ORDER[b.state];
	});

	return (
		<div className='status-scroll'>
			{sortedStatuses.map(s => (
				<div key={s.id} className="status-check">
					<div className="status-check-details">
						<StateIcon state={s.state} />
						<Avatar for={{ avatarUrl: s.avatarUrl, url: s.url }} />
						<span className="status-check-detail-text">
							{/* allow-any-unicode-next-line */}
							{s.workflowName ? `${s.workflowName} / ` : null}{s.context}{s.event ? ` (${s.event})` : null} {s.description ? `— ${s.description}` : null}
						</span>
					</div>
					<div>
						{s.isRequired ? (
							<span className="label">Required</span>
						) : null}
						{s.targetUrl ? <CheckDetailsLink url={s.targetUrl} />
							: <span className="status-check-link-placeholder" aria-hidden="true">Details</span>}
						{s.isCheckRun && s.databaseId && s.state === CheckState.Failure ? <ViewCheckLogsButton status={s} />
							: <span className="view-check-logs-placeholder" aria-hidden="true" />}
					</div>
				</div>
			))}
		</div>
	);
};

function StateIcon({ state }: { state: CheckState }) {
	switch (state) {
		case CheckState.Neutral:
			return skipIcon;
		case CheckState.Success:
			return checkIcon;
		case CheckState.Failure:
			return closeIcon;
	}
	return circleFilledIcon;
}
