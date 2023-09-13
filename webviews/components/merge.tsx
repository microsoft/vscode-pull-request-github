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
	useRef,
	useState,
} from 'react';
import { groupBy } from '../../src/common/utils';
import {
	CheckState,
	GithubItemStateEnum,
	MergeMethod,
	PullRequestCheckStatus,
	PullRequestMergeability,
	PullRequestReviewRequirement,
	reviewerId,
} from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { Reviewer } from '../components/reviewer';
import { AutoMerge } from './automergeSelect';
import { Dropdown } from './dropdown';
import { alertIcon, checkIcon, closeIcon, mergeIcon, pendingIcon, requestChanges, skipIcon } from './icon';
import { nbsp } from './space';
import { Avatar } from './user';

const PRStatusMessage = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	return pr.state === GithubItemStateEnum.Merged ? (
		<div className="branch-status-message">
			<div className="branch-status-icon">{isSimple ? mergeIcon : null}</div>{' '}
			{'Pull request successfully merged.'}
		</div>
	) : pr.state === GithubItemStateEnum.Closed ? (
		<div className="branch-status-message">{'This pull request is closed.'}</div>
	) : null;
};

const DeleteOption = ({ pr }: { pr: PullRequest }) => {
	return pr.state === GithubItemStateEnum.Open ? null : <DeleteBranch {...pr} />;
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
	}, status?.statuses);

	return state === GithubItemStateEnum.Open && status?.statuses.length ? (
		<>
			<div className="status-section">
				<div className="status-item">
					<StateIcon state={status.state} />
					<p className="status-item-detail-text">{getSummaryLabel(status.statuses)}</p>
					<button
						id="status-checks-display-button"
						className="secondary small-button"
						onClick={toggleDetails}
					>
						{showDetails ? 'Hide' : 'Show'}
					</button>
				</div>
				{showDetails ? <StatusCheckDetails statuses={status.statuses} /> : null}
			</div>
		</>
	) : null;
};

const RequiredReviewers = ({ pr }: { pr: PullRequest }) => {
	const { state, reviewRequirement } = pr;
	if (!reviewRequirement || state !== GithubItemStateEnum.Open) {
		return null;
	}
	return (
		<>
			<div className="status-section">
				<div className="status-item">
					<RequiredReviewStateIcon state={reviewRequirement.state} />
					<p className="status-item-detail-text">
					{getRequiredReviewSummary(reviewRequirement)}
					</p>
				</div>
			</div>
		</>
	);
};

const InlineReviewers = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	return isSimple && pr.state === GithubItemStateEnum.Open ? (
		pr.reviewers ? (
			<div className="section">
				{' '}
				{pr.reviewers.map(state => (
					<Reviewer key={reviewerId(state.reviewer)} {...state} />
				))}
			</div>
		) : null
	) : null;
};

export const StatusChecksSection = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	if (pr.isIssue) {
		return null;
	}

	return (
		<div id="status-checks">
			{
				<>
					<PRStatusMessage pr={pr} isSimple={isSimple} />
					<RequiredReviewers pr={pr} />
					<StatusChecks pr={pr} />
					<InlineReviewers pr={pr} isSimple={isSimple} />
					<MergeStatusAndActions pr={pr} isSimple={isSimple} />
					<DeleteOption pr={pr} />
				</>
			}
		</div>
	);
};

export const MergeStatusAndActions = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	if (isSimple && pr.state !== GithubItemStateEnum.Open) {
		const { create } = useContext(PullRequestContext);

		const string = 'Create New Pull Request...';
		return (
			<div className="branch-status-container">
				<form>
					<button type="submit" onClick={create}>
						{string}
					</button>
				</form>
			</div>
		);
	} else if (pr.state !== GithubItemStateEnum.Open) {
		return null;
	}

	const { mergeable: _mergeable } = pr;

	const [mergeable, setMergeability] = useState(_mergeable);
	if ((_mergeable !== mergeable) && (_mergeable !== PullRequestMergeability.Unknown)) {
		setMergeability(_mergeable);
	}
	const { checkMergeability } = useContext(PullRequestContext);

	useEffect(() => {
		const handle = setInterval(async () => {
			if (mergeable === PullRequestMergeability.Unknown) {
				const newMergeability = await checkMergeability();
				setMergeability(newMergeability);
			}
		}, 3000);
		return () => clearInterval(handle);
	}, [mergeable]);

	return (
		<div>
			<MergeStatus mergeable={mergeable} isSimple={isSimple} />
			<PrActions pr={{ ...pr, mergeable }} isSimple={isSimple} />
		</div>
	);
};

export default StatusChecksSection;

export const MergeStatus = ({ mergeable, isSimple }: { mergeable: PullRequestMergeability; isSimple: boolean }) => {
	let icon: JSX.Element | null = pendingIcon;
	let summary: string = 'Checking if this branch can be merged...';
	if (mergeable === PullRequestMergeability.Mergeable) {
		icon = checkIcon;
		summary = 'This branch has no conflicts with the base branch.';
	} else if (mergeable === PullRequestMergeability.Conflict) {
		icon = closeIcon;
		summary = 'This branch has conflicts that must be resolved.';
	} else if (mergeable === PullRequestMergeability.NotMergeable) {
		icon = closeIcon;
		summary = 'Branch protection policy must be fulfilled before merging.';
	} else if (mergeable === PullRequestMergeability.Behind) {
		icon = alertIcon;
		summary = 'This branch is out-of-date with the base branch.';
	}

	if (isSimple) {
		icon = null;
	}
	return (
		<div className="status-item status-section">
			{icon}
			<p>
				{summary}
			</p>
		</div>
	);
};

export const ReadyForReview = ({ isSimple }: { isSimple: boolean }) => {
	const [isBusy, setBusy] = useState(false);
	const { readyForReview, updatePR } = useContext(PullRequestContext);

	const markReadyForReview = useCallback(async () => {
		try {
			setBusy(true);
			await readyForReview();
			updatePR({ isDraft: false });
		} finally {
			setBusy(false);
		}
	}, [setBusy, readyForReview, updatePR]);

	return (
		<div className="ready-for-review-container">
			<div className='ready-for-review-text-wrapper'>
				<div className="ready-for-review-icon">{isSimple ? null : alertIcon}</div>
				<div>
					<div className="ready-for-review-heading">This pull request is still a work in progress.</div>
					<div className="ready-for-review-meta">Draft pull requests cannot be merged.</div>
				</div>
			</div>
			<div className='button-container'>
				<button disabled={isBusy} onClick={markReadyForReview}>Ready for review</button>
			</div>
		</div>
	);
};

export const Merge = (pr: PullRequest) => {
	const select = useRef<HTMLSelectElement>();
	const [selectedMethod, selectMethod] = useState<MergeMethod | null>(null);

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	return (
		<div className="automerge-section wrapper">
			<button onClick={() => selectMethod(select.current.value as MergeMethod)}>Merge Pull Request</button>
			{nbsp}using method{nbsp}
			<MergeSelect ref={select} {...pr} />
		</div>
	);
};

export const PrActions = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	const { hasWritePermission, canEdit, isDraft, mergeable, continueOnGitHub } = pr;
	if (continueOnGitHub) {
		return canEdit ? <MergeOnGitHub /> : null;
	}
	if (isDraft) {
		// Only PR author and users with push rights can mark draft as ready for review
		return canEdit ? <ReadyForReview isSimple={isSimple} /> : null;
	}

	if (mergeable === PullRequestMergeability.Mergeable && hasWritePermission) {
		return isSimple ? <MergeSimple {...pr} /> : <Merge {...pr} />;
	} else if (hasWritePermission) {
		const ctx = useContext(PullRequestContext);
		return (
			<AutoMerge
				updateState={(params: Partial<{ autoMerge: boolean; autoMergeMethod: MergeMethod }>) => {
					return ctx.updateAutoMerge(params);
				}}
				{...pr}
				defaultMergeMethod={pr.autoMergeMethod ?? pr.defaultMergeMethod}
			/>
		);
	}

	return null;
};

export const MergeOnGitHub = () => {
	const { openOnGitHub } = useContext(PullRequestContext);
	return (
		<button id="merge-on-github" type="submit" onClick={() => openOnGitHub()}>
			Merge on github.com
		</button>
	);
};

export const MergeSimple = (pr: PullRequest) => {
	const { merge, updatePR } = useContext(PullRequestContext);
	async function submitAction(selected: MergeMethod): Promise<void> {
		const { state } = await merge({
			title: '',
			description: '',
			method: selected,
		});
		updatePR({ state });
	}

	const availableOptions = Object.keys(MERGE_METHODS)
		.filter(method => pr.mergeMethodsAvailability[method])
		.reduce((methods, key) => {
			methods[key] = MERGE_METHODS[key];
			return methods;
		}, {});

	return <Dropdown options={availableOptions} defaultOption={pr.defaultMergeMethod} submitAction={submitAction} />;
};

export const DeleteBranch = (pr: PullRequest) => {
	const { deleteBranch } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	if (pr.isRemoteHeadDeleted !== false && pr.isLocalHeadDeleted !== false) {
		return <div />;
	} else {
		return (
			<div className="branch-status-container">
				<form
					onSubmit={async event => {
						event.preventDefault();

						try {
							setBusy(true);
							const result = await deleteBranch();
							if (result && result.cancelled) {
								setBusy(false);
							}
						} finally {
							setBusy(false);
						}
					}}
				>
					<button disabled={isBusy} className="secondary" type="submit">
						Delete branch...
					</button>
				</form>
			</div>
		);
	}
};

function ConfirmMerge({ pr, method, cancel }: { pr: PullRequest; method: MergeMethod; cancel: () => void }) {
	const { merge, updatePR } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	return (
		<div>
			<form id='merge-comment-form'
				onSubmit={async event => {
					event.preventDefault();

					try {
						setBusy(true);
						const { title, description }: any = event.target;
						const { state } = await merge({
							title: title?.value,
							description: description?.value,
							method,
						});
						updatePR({ state });
					} finally {
						setBusy(false);
					}
				}}
			>
				{method === 'rebase' ? null : (<input type="text" name="title" defaultValue={getDefaultTitleText(method, pr)} />)}
				{method === 'rebase' ? null : (<textarea name="description" defaultValue={getDefaultDescriptionText(method, pr)} />)}
				<div className="form-actions" id={method === 'rebase' ? 'rebase-actions' : ''}>
					<button className="secondary" onClick={cancel}>Cancel</button>
					<button disabled={isBusy} type="submit" id="confirm-merge">{method === 'rebase' ? 'Confirm ' : ''}{MERGE_METHODS[method]}</button>
				</div>
			</form>
		</div>
	);
}

function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return `Merge pull request #${pr.number} from ${pr.head}`;
		case 'squash':
			return `${pr.title} (#${pr.number})`;
		default:
			return '';
	}
}

function getDefaultDescriptionText(mergeMethod: string, pr: PullRequest) {
	return mergeMethod === 'merge' ? pr.title : '';
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

const StatusCheckDetails = ( { statuses }: { statuses: PullRequestCheckStatus[] }) => (
	<div>
		{statuses.map(s => (
			<div key={s.id} className="status-check">
				<div className="status-check-details">
					<StateIcon state={s.state} />
					<Avatar for={{ avatarUrl: s.avatarUrl, url: s.url }} />
					<span className="status-check-detail-text">
						{/* allow-any-unicode-next-line */}
						{s.context} {s.description ? `— ${s.description}` : ''}
					</span>
				</div>
				<div>
				{s.isRequired ? (
					<span className="label">Required</span>
				) : null }
				{!!s.targetUrl ? (
					<a href={s.targetUrl} title={s.targetUrl}>
						Details
					</a>
				) : null}
				</div>
			</div>
		))}
	</div>
);

function getSummaryLabel(statuses: PullRequestCheckStatus[]) {
	const statusTypes = groupBy(statuses, (status: PullRequestCheckStatus) => {
		switch (status.state) {
			case CheckState.Success:
			case CheckState.Failure:
			case CheckState.Neutral:
				return status.state;
			default:
				return CheckState.Pending;
		}
	});
	const statusPhrases: string[] = [];
	for (const statusType of Object.keys(statusTypes)) {
		const numOfType = statusTypes[statusType].length;
		let statusAdjective = '';
		switch (statusType) {
			case CheckState.Success:
				statusAdjective = 'successful';
				break;
			case CheckState.Failure:
				statusAdjective = 'failed';
				break;
			case CheckState.Neutral:
				statusAdjective = 'skipped';
				break;
			default:
				statusAdjective = 'pending';
		}

		const status =
			numOfType > 1 ? `${numOfType} ${statusAdjective} checks` : `${numOfType} ${statusAdjective} check`;

		statusPhrases.push(status);
	}

	return statusPhrases.join(' and ');
}

function StateIcon({ state }: { state: CheckState }) {
	switch (state) {
		case CheckState.Neutral:
			return skipIcon;
		case CheckState.Success:
			return checkIcon;
		case CheckState.Failure:
			return closeIcon;
	}
	return pendingIcon;
}

function RequiredReviewStateIcon({ state }: { state: CheckState }) {
	switch (state) {
		case CheckState.Pending:
			return requestChanges;
		case CheckState.Failure:
			return closeIcon;
	}

	return checkIcon;
}

function getRequiredReviewSummary(requirement: PullRequestReviewRequirement) {
	const approvalCount = requirement.approvals.length;
	const requestedChangesCount = requirement.requestedChanges.length;
	const requiredCount = requirement.count;

	switch (requirement.state) {
		case CheckState.Failure:
			return `At least ${requiredCount} approving review${requiredCount > 1 ? 's' : ''} is required by reviewers with write access.`;
		case CheckState.Pending:
			return `${requestedChangesCount} review${requestedChangesCount > 1 ? 's' : ''} requesting changes by reviewers with write access.`;
	}

	return `${approvalCount} approving review${approvalCount > 1 ? 's' : ''} by reviewers with write access.`;
}
