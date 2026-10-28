/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button } from 'azure-devops-ui/Button';
import { Card } from 'azure-devops-ui/Card';
import { Coin, CoinSize } from 'azure-devops-ui/Coin';
import { Link } from 'azure-devops-ui/Link';
import { IMenuItem, MenuItemType, MoreButton } from 'azure-devops-ui/Menu';
import { Pill, PillSize, PillVariant } from 'azure-devops-ui/Pill';
import { Spinner, SpinnerSize } from 'azure-devops-ui/Spinner';
import { SplitButton } from 'azure-devops-ui/SplitButton';
import { IStatusProps, Status, Statuses, StatusSize } from 'azure-devops-ui/Status';
import { TextField } from 'azure-devops-ui/TextField';
import React, { useCallback, useContext, useEffect, useState } from 'react';
import { AzdoIdentity, AzdoOverview, AzdoPolicy, AzdoPolicyState, AzdoReviewer, AzdoVote, AzdoWorkItem } from '../../common/azdoOverview';
import { CommentEvent, EventType, TimelineEvent } from '../../src/common/timelineEvent';
import { PullRequest } from '../../src/github/views';
import PullRequestContext, { PRContext } from '../common/context';
import { CommentView } from '../components/comment';
import { Timeline } from '../components/timeline';

const voteText: Record<AzdoVote, string> = {
	[AzdoVote.Approved]: 'Approved',
	[AzdoVote.ApprovedWithSuggestions]: 'Approved with suggestions',
	[AzdoVote.NoVote]: 'No response',
	[AzdoVote.WaitingForAuthor]: 'Waiting for author',
	[AzdoVote.Rejected]: 'Rejected',
};

const voteStatus = (vote: AzdoVote): IStatusProps | undefined =>
	vote > 0 ? Statuses.Success : vote === AzdoVote.WaitingForAuthor ? Statuses.Waiting : vote === AzdoVote.Rejected ? Statuses.Failed : undefined;

const policyStatus: Record<AzdoPolicyState, IStatusProps> = {
	succeeded: Statuses.Success,
	failed: Statuses.Failed,
	running: Statuses.Running,
	queued: Statuses.Queued,
	notApplicable: Statuses.Skipped,
	unknown: Statuses.Waiting,
};

const ago = (value: string | undefined) => {
	if (!value) {
		return '';
	}
	const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
	const units: [number, string][] = [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
	for (const [size, unit] of units) {
		if (seconds >= size) {
			return `${Math.floor(seconds / size)}${unit} ago`;
		}
	}
	return 'just now';
};

const Avatar = ({ identity, size = CoinSize.size24 }: { identity: AzdoIdentity; size?: CoinSize }) =>
	<Coin displayName={identity.displayName} imageUrl={identity.imageUrl} size={size} />;

/** Owns the PR view-model from the shared protocol plus the Azure-specific overview. */
function usePullRequest(ctx: PRContext) {
	const [pr, setPR] = useState<PullRequest | undefined>(ctx.pr);
	const [details, setDetails] = useState<AzdoOverview>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			setDetails(await ctx.postMessage({ command: 'azdo.pr.details' }));
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [ctx]);

	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
		const onMessage = (event: MessageEvent) => {
			if (event.data?.res?.command === 'pr.initialize') {
				void reload();
			}
		};
		window.addEventListener('message', onMessage);
		ctx.postMessage({ command: 'ready' });
		if (ctx.pr) {
			void reload();
		}
		return () => {
			ctx.onchange = null;
			window.removeEventListener('message', onMessage);
		};
	}, []);

	/** Runs an action that replies with a fresh overview (or nothing, in which case the overview is reloaded). */
	const run = useCallback(async (message: { command: string; args?: unknown }) => {
		setLoading(true);
		try {
			const result: Partial<AzdoOverview> | undefined = await ctx.postMessage(message);
			if (Array.isArray(result?.reviewers) && Array.isArray(result?.policies)) {
				setDetails(result as AzdoOverview);
			} else {
				await reload();
			}
		} catch {
			// The extension host already surfaced the error.
		} finally {
			setLoading(false);
		}
	}, [ctx, reload]);

	return { pr, details, error, loading, reload, run };
}

export function App() {
	const ctx = useContext(PullRequestContext);
	const state = usePullRequest(ctx);
	const { pr, details, error } = state;

	if (!pr || !details) {
		return <div className="azdo-loading">
			{error ? <span className="azdo-error">{error}</span> : <Spinner size={SpinnerSize.large} label="Loading pull request…" />}
		</div>;
	}
	return <div className="azdo-page">
		<PageHeader pr={pr} details={details} {...state} />
		<div className="azdo-columns">
			<main className="azdo-main">
				<StatusCard details={details} run={state.run} />
				<DescriptionCard pr={pr} />
				<Activity pr={pr} />
			</main>
			<aside className="azdo-sidebar">
				<ReviewersSection details={details} run={state.run} />
				<TagsSection details={details} run={state.run} />
				<WorkItemsSection details={details} run={state.run} />
			</aside>
		</div>
	</div>;
}

type Actions = ReturnType<typeof usePullRequest>;

function PageHeader({ pr, details, loading, run, reload }: { pr: PullRequest; details: AzdoOverview } & Actions) {
	const ctx = useContext(PullRequestContext);
	const active = details.status === 'active';
	const statusPill = details.status === 'completed' ? { text: 'Completed', color: { red: 16, green: 124, blue: 16 } }
		: details.status === 'abandoned' ? { text: 'Abandoned', color: { red: 168, green: 0, blue: 0 } }
			: details.isDraft ? { text: 'Draft', color: undefined }
				: { text: 'Active', color: { red: 0, green: 120, blue: 212 } };
	const vote = (value: AzdoVote) => run({ command: 'azdo.pr.vote', args: { vote: value } });
	const voteItems: IMenuItem[] = [
		{ id: 'approve', text: 'Approve', onActivate: () => { vote(AzdoVote.Approved); } },
		{ id: 'suggestions', text: 'Approve with suggestions', onActivate: () => { vote(AzdoVote.ApprovedWithSuggestions); } },
		{ id: 'wait', text: 'Wait for author', onActivate: () => { vote(AzdoVote.WaitingForAuthor); } },
		{ id: 'reject', text: 'Reject', onActivate: () => { vote(AzdoVote.Rejected); } },
		{ id: 'divider', itemType: MenuItemType.Divider },
		{ id: 'reset', text: 'Reset feedback', disabled: !details.viewerVote, onActivate: () => { vote(AzdoVote.NoVote); } },
	];
	const moreItems: IMenuItem[] = [
		{ id: 'browser', text: 'Open in browser', iconProps: { iconName: 'OpenInNewWindow' }, onActivate: () => { ctx.postMessage({ command: 'azdo.pr.open-url', args: { url: details.url } }); } },
		{ id: 'copy', text: 'Copy pull request URL', iconProps: { iconName: 'Copy' }, onActivate: () => { ctx.copyPrLink(); } },
		...(active ? [
			{ id: 'divider1', itemType: MenuItemType.Divider },
			details.isDraft
				? { id: 'publish', text: 'Publish', onActivate: () => { ctx.readyForReview().finally(() => reload()); } }
				: { id: 'draft', text: 'Mark as draft', onActivate: () => { ctx.convertToDraft().finally(() => reload()); } },
			{ id: 'divider2', itemType: MenuItemType.Divider },
			{ id: 'abandon', text: 'Abandon', iconProps: { iconName: 'Blocked' }, onActivate: () => { ctx.close().finally(() => reload()); } },
		] as IMenuItem[] : []),
	];
	const resolvedText = details.threads.active === 0
		? (details.threads.resolved > 0 ? 'All comments resolved' : '')
		: `${details.threads.active} active comment${details.threads.active === 1 ? '' : 's'}`;

	return <header className="azdo-header">
		<div className="azdo-header-row">
			<h1 className="azdo-title">{details.title}</h1>
			<div className="azdo-header-actions">
				{active && !details.isAuthor && <SplitButton
					primary={!details.viewerVote}
					buttonProps={{ text: details.viewerVote ? voteText[details.viewerVote] : 'Approve', onClick: () => { vote(AzdoVote.Approved); } }}
					menuButtonProps={{ ariaLabel: 'More vote options', contextualMenuProps: { menuProps: { id: 'azdo-vote', items: voteItems } } }}
				/>}
				{active && details.isDraft && details.isAuthor && <Button primary text="Publish" onClick={() => { ctx.readyForReview().finally(() => reload()); }} />}
				{active && !details.isDraft && (details.autoComplete
					? <Button text="Cancel auto-complete" iconProps={{ iconName: 'Cancel' }} onClick={() => { ctx.updateAutoMerge({ autoMerge: false }).finally(() => reload()); }} />
					: <SplitButton
						primary={details.isAuthor}
						buttonProps={{ text: 'Set auto-complete', onClick: () => { run({ command: 'azdo.pr.complete', args: { autoComplete: true } }); } }}
						menuButtonProps={{
							ariaLabel: 'More completion options', contextualMenuProps: {
								menuProps: { id: 'azdo-complete', items: [{ id: 'complete', text: 'Complete', onActivate: () => { run({ command: 'azdo.pr.complete', args: { autoComplete: false } }); } }] },
							},
						}}
					/>)}
				<MoreButton contextualMenuProps={{ menuProps: { id: 'azdo-more', items: moreItems } }} />
			</div>
		</div>
		<div className="azdo-header-row azdo-subtitle">
			<div className="azdo-subtitle-text">
				<Pill size={PillSize.compact} variant={statusPill.color ? PillVariant.colored : PillVariant.outlined} color={statusPill.color}>{statusPill.text}</Pill>
				<span className="azdo-id">!{details.number}</span>
				<Avatar identity={details.createdBy} size={CoinSize.size20} />
				<span>{details.createdBy.displayName} {active ? 'proposes to merge' : details.status === 'completed' ? 'merged' : 'proposed to merge'}</span>
				<Link href={details.sourceBranchUrl} className="azdo-branch">{details.sourceBranch}</Link>
				<Button subtle iconProps={{ iconName: 'Copy' }} ariaLabel="Copy source branch name" onClick={() => { navigator.clipboard.writeText(details.sourceBranch); }} />
				<span>into</span>
				<Link href={details.targetBranchUrl} className="azdo-branch">{details.targetBranch}</Link>
				{resolvedText && <span className="azdo-secondary">{resolvedText}</span>}
				{details.autoComplete && <span className="azdo-secondary">Auto-complete set by {details.autoComplete.setBy.displayName}</span>}
			</div>
			<div className="azdo-header-reviewers">
				{details.reviewers.map(reviewer => <span key={reviewer.id} className="azdo-avatar-with-vote" title={`${reviewer.displayName}: ${voteText[reviewer.vote]}`}>
					<Avatar identity={reviewer} />
					{voteStatus(reviewer.vote) && <Status {...voteStatus(reviewer.vote)!} size={StatusSize.s} className="azdo-vote-badge" />}
				</span>)}
			</div>
		</div>
		{/* Same place as the original extension: below the subtitle, checkout then refresh. */}
		<div className="azdo-header-row azdo-header-checkout">
			<CheckoutButton pr={pr} />
			<RefreshButton reload={reload} />
			{loading && <Spinner size={SpinnerSize.small} />}
		</div>
	</header>;
}

/** Reloads the pull request from Azure DevOps, not just the page. */
function RefreshButton({ reload }: { reload: () => Promise<void> }) {
	const ctx = useContext(PullRequestContext);
	const [busy, setBusy] = useState(false);
	const refresh = async () => {
		setBusy(true);
		try {
			await ctx.postMessage({ command: 'azdo.pr.reload' });
			await reload();
		} catch {
			// The extension host already reported the failure.
		} finally {
			setBusy(false);
		}
	};
	return <Button text={busy ? 'Refreshing…' : 'Refresh'} iconProps={{ iconName: 'Refresh' }} disabled={busy} onClick={refresh}
		tooltipProps={{ text: 'Reload this pull request from Azure DevOps' }} />;
}

/** Mirrors the original checkout control, but checking out creates a worktree and opens it in a new window. */
function CheckoutButton({ pr }: { pr: PullRequest }) {
	const ctx = useContext(PullRequestContext);
	const [busy, setBusy] = useState(false);
	const run = (action: () => Promise<unknown>) => async () => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	const worktree = run(() => ctx.postMessage({ command: 'azdo.pr.checkout-worktree' }));
	const items: IMenuItem[] = [
		pr.isCurrentlyCheckedOut
			? { id: 'exit', text: `Checkout '${pr.doneCheckoutBranch}'`, onActivate: () => { void run(() => ctx.exitReviewMode())(); } }
			: { id: 'branch', text: 'Checkout branch in this window', onActivate: () => { void run(() => ctx.checkout())(); } },
		{ id: 'worktree', text: 'Checkout in new worktree', disabled: pr.isCurrentlyCheckedOut, onActivate: () => { void worktree(); } },
		{ id: 'divider', itemType: MenuItemType.Divider },
		{ id: 'changes', text: 'Open changes', onActivate: () => { void run(() => ctx.openChanges())(); } },
	];
	return <SplitButton
		disabled={busy}
		buttonProps={pr.isCurrentlyCheckedOut
			? { text: `Checkout '${pr.doneCheckoutBranch}'`, iconProps: { iconName: 'BranchPullRequest' }, onClick: () => { void run(() => ctx.exitReviewMode())(); } }
			: { text: 'Checkout', iconProps: { iconName: 'BranchPullRequest' }, onClick: () => { void worktree(); } }}
		menuButtonProps={{ ariaLabel: 'More checkout options', contextualMenuProps: { menuProps: { id: 'azdo-checkout', items } } }}
	/>;
}

function StatusRow({ status, title, subtitle, children }: { status: IStatusProps; title: React.ReactNode; subtitle?: React.ReactNode; children?: React.ReactNode }) {
	return <div className="azdo-status-row">
		<Status {...status} size={StatusSize.l} />
		<div className="azdo-status-text">
			<div>{title}</div>
			{subtitle && <div className="azdo-secondary azdo-small">{subtitle}</div>}
			{children}
		</div>
	</div>;
}

function PolicyItem({ policy, run }: { policy: AzdoPolicy; run: Actions['run'] }) {
	return <div className="azdo-policy">
		<div className="azdo-policy-header">
			<Status {...policyStatus[policy.state]} size={StatusSize.m} animated={policy.state === 'running'} />
			{policy.buildUrl ? <Link href={policy.buildUrl} className="azdo-policy-name">{policy.name}</Link> : <span className="azdo-policy-name">{policy.name}</span>}
			<span className="azdo-secondary">{policy.description}{policy.isBlocking ? '' : ' (optional)'}</span>
			<span className="azdo-spacer" />
			{policy.canRequeue && policy.state !== 'running' && policy.state !== 'queued'
				&& <Button subtle text="Re-queue" onClick={() => { run({ command: 'azdo.pr.requeue', args: { id: policy.id } }); }} />}
		</div>
		{policy.issues.length > 0 && <pre className="azdo-log">{policy.issues.map((issue, index) => <div key={index}>{issue}</div>)}</pre>}
	</div>;
}

function StatusCard({ details, run }: { details: AzdoOverview; run: Actions['run'] }) {
	const [showAll, setShowAll] = useState(false);
	const required = details.policies.filter(policy => policy.isBlocking);
	const optional = details.policies.filter(policy => !policy.isBlocking);
	const failed = required.filter(policy => policy.state === 'failed');
	const pending = required.filter(policy => policy.state === 'running' || policy.state === 'queued' || policy.state === 'unknown');
	const optionalFailed = optional.filter(policy => policy.state === 'failed');
	const policySummary: { status: IStatusProps; title: string } = !details.policies.length
		? { status: Statuses.Skipped, title: 'No checks configured' }
		: failed.length ? { status: Statuses.Failed, title: `${failed.length} of ${required.length} required check${required.length === 1 ? '' : 's'} failed` }
			: pending.length ? { status: Statuses.Running, title: `${pending.length} of ${required.length} required check${required.length === 1 ? '' : 's'} pending` }
				: { status: Statuses.Success, title: required.length ? 'All required checks succeeded' : 'No required checks' };
	const optionalSummary = optional.length
		? optionalFailed.length ? `${optionalFailed.length} optional check${optionalFailed.length === 1 ? '' : 's'} failed` : `Optional check${optional.length === 1 ? '' : 's'} succeeded`
		: undefined;
	const highlighted = details.policies.filter(policy => policy.state === 'failed' || (policy.isBlocking && policy.state !== 'succeeded' && policy.state !== 'notApplicable'));
	const shown = showAll ? details.policies : highlighted;

	const approvals = details.reviewers.filter(reviewer => reviewer.vote > 0);
	const rejected = details.reviewers.filter(reviewer => reviewer.vote === AzdoVote.Rejected);
	const waiting = details.reviewers.filter(reviewer => reviewer.vote === AzdoVote.WaitingForAuthor);
	const requiredPending = details.reviewers.filter(reviewer => reviewer.isRequired && reviewer.vote <= 0);
	const reviewSummary: { status: IStatusProps; title: string; subtitle?: string } = rejected.length
		? { status: Statuses.Failed, title: `${rejected.length} reviewer${rejected.length === 1 ? '' : 's'} rejected` }
		: waiting.length ? { status: Statuses.Warning, title: `${waiting.length} reviewer${waiting.length === 1 ? ' is' : 's are'} waiting for the author` }
			: requiredPending.length ? { status: Statuses.Waiting, title: `Waiting on ${requiredPending.length} required reviewer${requiredPending.length === 1 ? '' : 's'}`, subtitle: requiredPending.map(reviewer => reviewer.displayName).join(', ') }
				: approvals.length ? { status: Statuses.Success, title: `${approvals.length} reviewer${approvals.length === 1 ? '' : 's'} approved` }
					: { status: Statuses.Waiting, title: 'No reviewers have approved' };

	const merge: { status: IStatusProps; title: string } | undefined = details.status !== 'active' ? undefined
		: details.mergeStatus === 'succeeded' ? { status: Statuses.Success, title: 'No merge conflicts' }
			: details.mergeStatus === 'conflicts' ? { status: Statuses.Failed, title: 'Merge conflicts must be resolved' }
				: details.mergeStatus === 'queued' ? { status: Statuses.Running, title: 'Checking for merge conflicts' }
					: details.mergeStatus === 'rejectedByPolicy' ? { status: Statuses.Failed, title: 'Merge rejected by policy' }
						: details.mergeStatus === 'failure' ? { status: Statuses.Failed, title: 'Merge check failed' }
							: undefined;

	return <Card className="azdo-card azdo-status-card" contentProps={{ contentPadding: false }}>
		<div className="azdo-status-list">
			{details.status === 'completed' && <StatusRow status={Statuses.Success} title={`Completed ${ago(details.closedDate)}`} />}
			{details.status === 'abandoned' && <StatusRow status={Statuses.Abandoned} title={`Abandoned ${ago(details.closedDate)}`} />}
			<StatusRow status={policySummary.status} title={policySummary.title} subtitle={details.policiesError ?? optionalSummary}>
				{shown.length > 0 && <div className="azdo-policies">{shown.map(policy => <PolicyItem key={policy.id} policy={policy} run={run} />)}</div>}
				{details.policies.length > highlighted.length && <Link className="azdo-view-checks" onClick={() => setShowAll(!showAll)}>
					{showAll ? 'Show fewer checks' : `View ${details.policies.length} checks`}
				</Link>}
			</StatusRow>
			<StatusRow status={reviewSummary.status} title={reviewSummary.title} subtitle={reviewSummary.subtitle} />
			{merge && <StatusRow status={merge.status} title={merge.title} />}
		</div>
	</Card>;
}

function DescriptionCard({ pr }: { pr: PullRequest }) {
	const ctx = useContext(PullRequestContext);
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(pr.body);
	const [saving, setSaving] = useState(false);
	const save = async () => {
		setSaving(true);
		try {
			const result: { body: string; bodyHTML: string } = await ctx.setDescription(text);
			ctx.updatePR({ body: result.body, bodyHTML: result.bodyHTML });
			setEditing(false);
		} finally {
			setSaving(false);
		}
	};
	return <Card
		className="azdo-card"
		titleProps={{ text: 'Description' }}
		headerCommandBarItems={editing ? [] : [{
			id: 'edit', iconProps: { iconName: 'Edit' }, ariaLabel: 'Edit description', subtle: true, important: true,
			onActivate: () => { setText(pr.body); setEditing(true); },
		}]}
	>
		{editing
			? <div className="azdo-edit">
				<TextField multiline rows={8} value={text} onChange={(_, value) => setText(value)} autoFocus />
				<div className="azdo-edit-actions">
					<Button text="Cancel" onClick={() => setEditing(false)} disabled={saving} />
					<Button primary text="Save" onClick={save} disabled={saving} />
				</div>
			</div>
			: pr.body
				? <div className="azdo-markdown" dangerouslySetInnerHTML={{ __html: pr.bodyHTML ?? '' }} />
				: <span className="azdo-secondary">No description provided.</span>}
	</Card>;
}

class ActivityBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
	override state: { error?: string } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error: String(error) };
	}
	override render() {
		return this.state.error ? <div className="azdo-error">Unable to show the activity feed: {this.state.error}</div> : this.props.children;
	}
}

type FeedItem = { kind: 'event'; event: TimelineEvent } | { kind: 'discussion'; comments: CommentEvent[] };

/** Azure discussions are threads; keep each general thread's replies with it instead of as separate timeline entries. */
function ActivityFeed({ events }: { events: TimelineEvent[] }) {
	const items: FeedItem[] = [];
	const discussions = new Map<string, CommentEvent[]>();
	for (const event of events) {
		if (event.event === EventType.Commented && event.threadId) {
			const existing = discussions.get(event.threadId);
			if (existing) {
				existing.push(event);
				continue;
			}
			const comments = [event];
			discussions.set(event.threadId, comments);
			items.push({ kind: 'discussion', comments });
		} else {
			items.push({ kind: 'event', event });
		}
	}
	return <>{items.map(item => item.kind === 'event'
		? <Timeline key={`event:${item.event.event}:${item.event.id}`} events={[item.event]} isIssue={false} />
		: <div key={`discussion:${item.comments[0].threadId}`} className="azdo-discussion">
			<CommentView comment={item.comments[0]} />
			{item.comments.length > 1 && <div className="azdo-replies">
				{item.comments.slice(1).map(comment => <CommentView key={comment.id} comment={comment} />)}
			</div>}
		</div>)}</>;
}

function Activity({ pr }: { pr: PullRequest }) {
	const ctx = useContext(PullRequestContext);
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		if (!text.trim()) {
			return;
		}
		setBusy(true);
		try {
			await ctx.submit(text);
			setText('');
		} finally {
			setBusy(false);
		}
	};
	return <section className="azdo-activity">
		{pr.discussionsError && <div className="azdo-error">{pr.discussionsError}</div>}
		<div className="azdo-timeline">
			<ActivityBoundary><ActivityFeed events={pr.events} /></ActivityBoundary>
		</div>
		<Card className="azdo-card azdo-comment-box">
			<div className="azdo-comment-input">
				<TextField
					multiline rows={text ? 4 : 1} placeholder="Add a comment…" value={text} disabled={busy}
					onChange={(_, value) => setText(value)}
					onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { void submit(); } }}
				/>
				{text && <div className="azdo-edit-actions">
					<Button text="Cancel" onClick={() => setText('')} disabled={busy} />
					<Button primary text="Comment" onClick={submit} disabled={busy} />
				</div>}
			</div>
		</Card>
	</section>;
}

function SidebarSection({ title, onAdd, addLabel, children }: { title: string; onAdd?: () => void; addLabel: string; children: React.ReactNode }) {
	return <section className="azdo-side-section">
		<div className="azdo-side-header">
			<h2>{title}</h2>
			{onAdd && <Button iconProps={{ iconName: 'Add' }} ariaLabel={addLabel} subtle onClick={onAdd} />}
		</div>
		{children}
	</section>;
}

function ReviewerRow({ reviewer }: { reviewer: AzdoReviewer }) {
	const status = voteStatus(reviewer.vote);
	return <div className="azdo-reviewer">
		<span className="azdo-reviewer-status">{status ? <Status {...status} size={StatusSize.m} /> : null}</span>
		<Avatar identity={reviewer} size={CoinSize.size32} />
		<div>
			<div>{reviewer.displayName}</div>
			<div className="azdo-secondary azdo-small">{voteText[reviewer.vote]}</div>
		</div>
	</div>;
}

function ReviewersSection({ details, run }: { details: AzdoOverview; run: Actions['run'] }) {
	const required = details.reviewers.filter(reviewer => reviewer.isRequired);
	const optional = details.reviewers.filter(reviewer => !reviewer.isRequired);
	return <SidebarSection title="Reviewers" addLabel="Add reviewers" onAdd={details.status === 'active' ? () => { run({ command: 'pr.change-reviewers' }); } : undefined}>
		<h3 className="azdo-side-subheader">Required</h3>
		{required.length ? required.map(reviewer => <ReviewerRow key={reviewer.id} reviewer={reviewer} />) : <div className="azdo-empty">No required reviewers</div>}
		<h3 className="azdo-side-subheader">Optional</h3>
		{optional.length ? optional.map(reviewer => <ReviewerRow key={reviewer.id} reviewer={reviewer} />) : <div className="azdo-empty">No optional reviewers</div>}
	</SidebarSection>;
}

function TagsSection({ details, run }: { details: AzdoOverview; run: Actions['run'] }) {
	return <SidebarSection title="Tags" addLabel="Add tags" onAdd={() => { run({ command: 'pr.add-labels' }); }}>
		{details.tags.length
			? <div className="azdo-tags">{details.tags.map(tag => <Pill key={tag} size={PillSize.compact} onRemoveClick={() => { run({ command: 'pr.remove-label', args: tag }); }}>{tag}</Pill>)}</div>
			: <div className="azdo-empty">No tags</div>}
	</SidebarSection>;
}

function WorkItemRow({ item, onRemove }: { item: AzdoWorkItem; onRemove: () => void }) {
	return <div className="azdo-work-item">
		<div>
			<Link href={item.url}>{item.type} {item.id}: {item.title}</Link>
			<div className="azdo-secondary azdo-small">{item.changedDate ? `Updated ${ago(item.changedDate)}, ` : ''}{item.state}</div>
		</div>
		<Button subtle iconProps={{ iconName: 'Cancel' }} ariaLabel={`Unlink work item ${item.id}`} onClick={onRemove} />
	</div>;
}

function WorkItemsSection({ details, run }: { details: AzdoOverview; run: Actions['run'] }) {
	return <SidebarSection title="Work items" addLabel="Link a work item" onAdd={() => { run({ command: 'azdo.pr.link-work-item' }); }}>
		{details.workItemsError && <div className="azdo-error azdo-small">{details.workItemsError}</div>}
		{details.workItems.length
			? details.workItems.map(item => <WorkItemRow key={item.id} item={item} onRemove={() => { run({ command: 'azdo.pr.unlink-work-item', args: { id: item.id } }); }} />)
			: <div className="azdo-empty">No work items</div>}
	</SidebarSection>;
}
