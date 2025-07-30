/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext } from 'react';
import { CloseResult, OpenCommitChangesArgs } from '../../common/views';
import { IComment } from '../../src/common/comment';
import { EventType, ReviewEvent, SessionLinkInfo, TimelineEvent } from '../../src/common/timelineEvent';
import { IProjectItem, MergeMethod, ReadyForReview } from '../../src/github/interface';
import { CancelCodingAgentReply, ChangeAssigneesReply, MergeArguments, MergeResult, ProjectItemsReply, PullRequest, SubmitReviewReply } from '../../src/github/views';
import { getState, setState, updateState } from './cache';
import { getMessageHandler, MessageHandler } from './message';

export class PRContext {
	constructor(
		public pr: PullRequest | undefined = getState(),
		public onchange: ((ctx: PullRequest | undefined) => void) | null = null,
		private _handler: MessageHandler | null = null,
	) {
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	public setTitle = async (title: string) => {
		const result = await this.postMessage({ command: 'pr.edit-title', args: { text: title } });
		this.updatePR({ titleHTML: result.titleHTML });
	};

	public setDescription = (description: string) =>
		this.postMessage({ command: 'pr.edit-description', args: { text: description } });

	public checkout = () => this.postMessage({ command: 'pr.checkout' });

	public openChanges = (openToTheSide?: boolean) => this.postMessage({ command: 'pr.open-changes', args: { openToTheSide } });

	public copyPrLink = () => this.postMessage({ command: 'pr.copy-prlink' });

	public copyVscodeDevLink = () => this.postMessage({ command: 'pr.copy-vscodedevlink' });

	public cancelCodingAgent = (event: TimelineEvent): Promise<CancelCodingAgentReply> => this.postMessage({ command: 'pr.cancel-coding-agent', args: event });

	public exitReviewMode = async () => {
		if (!this.pr) {
			return;
		}
		return this.postMessage({
			command: 'pr.checkout-default-branch',
			args: this.pr.repositoryDefaultBranch,
		});
	};

	public gotoChangesSinceReview = () => this.postMessage({ command: 'pr.gotoChangesSinceReview' });

	public refresh = async () =>{
		if (this.pr) {
			this.pr.busy = true;
		}
		this.updatePR(this.pr);
		await this.postMessage({ command: 'pr.refresh' });
		if (this.pr) {
			this.pr.busy = false;
		}
		this.updatePR(this.pr);
	};

	public checkMergeability = () => this.postMessage({ command: 'pr.checkMergeability' });

	public changeEmail = async (current: string) => {
		const newEmail = await this.postMessage({ command: 'pr.change-email', args: current });
		this.updatePR({ emailForCommit: newEmail });
	};

	public merge = async (args: MergeArguments): Promise<MergeResult> => {
		const result: MergeResult = await this.postMessage({ command: 'pr.merge', args });
		return result;
	}

	public openOnGitHub = () => this.postMessage({ command: 'pr.openOnGitHub' });

	public deleteBranch = () => this.postMessage({ command: 'pr.deleteBranch' });

	public revert = async () => {
		this.updatePR({ busy: true });
		const revertResult = await this.postMessage({ command: 'pr.revert' });
		this.updatePR({ busy: false, ...revertResult });
	};

	public readyForReview = (): Promise<ReadyForReview> => this.postMessage({ command: 'pr.readyForReview' });

	public addReviewers = () => this.postMessage({ command: 'pr.change-reviewers' });
	public changeProjects = (): Promise<ProjectItemsReply> => this.postMessage({ command: 'pr.change-projects' });
	public removeProject = (project: IProjectItem) => this.postMessage({ command: 'pr.remove-project', args: project });
	public addMilestone = () => this.postMessage({ command: 'pr.add-milestone' });
	public removeMilestone = () => this.postMessage({ command: 'pr.remove-milestone' });
	public addAssignees = (): Promise<ChangeAssigneesReply> => this.postMessage({ command: 'pr.change-assignees' });
	public addAssigneeYourself = (): Promise<ChangeAssigneesReply> => this.postMessage({ command: 'pr.add-assignee-yourself' });
	public addAssigneeCopilot = (): Promise<ChangeAssigneesReply> => this.postMessage({ command: 'pr.add-assignee-copilot' });
	public addLabels = () => this.postMessage({ command: 'pr.add-labels' });
	public create = () => this.postMessage({ command: 'pr.open-create' });

	public deleteComment = async (args: { id: number; pullRequestReviewId?: number }) => {
		await this.postMessage({ command: 'pr.delete-comment', args });
		const { pr } = this;
		if (!pr) {
			throw new Error('Unexpectedly no PR when trying to delete comment');
		}
		const { id, pullRequestReviewId } = args;
		if (!pullRequestReviewId) {
			this.updatePR({
				events: pr.events.filter(e => e.id !== id),
			});
			return;
		}
		const index = pr.events.findIndex(e => e.id === pullRequestReviewId);
		if (index === -1) {
			console.error('Could not find review:', pullRequestReviewId);
			return;
		}
		const review: ReviewEvent = pr.events[index] as ReviewEvent;
		if (!review.comments) {
			console.error('No comments to delete for review:', pullRequestReviewId, review);
			return;
		}
		pr.events.splice(index, 1, {
			...review,
			comments: review.comments.filter(c => c.id !== id),
		});
		this.updatePR(pr);
	};

	public editComment = (args: { comment: IComment; text: string }) =>
		this.postMessage({ command: 'pr.edit-comment', args });

	public updateDraft = (id: number, body: string) => {
		const pullRequest = getState();
		const pendingCommentDrafts = pullRequest.pendingCommentDrafts || Object.create(null);
		if (body === pendingCommentDrafts[id]) {
			return;
		}
		pendingCommentDrafts[id] = body;
		this.updatePR({ pendingCommentDrafts: pendingCommentDrafts });
	};

	private async submitReviewCommand(command: string, body: string) {
		try {
			const result: SubmitReviewReply = await this.postMessage({ command, args: body });
			return this.appendReview(result);
		} catch (error) {
			return this.updatePR({ busy: false });
		}
	}

	public requestChanges = (body: string) => this.submitReviewCommand('pr.request-changes', body);

	public approve = (body: string) => this.submitReviewCommand('pr.approve', body);

	public submit = (body: string) => this.submitReviewCommand('pr.submit', body);

	public close = async (body?: string) => {
		const { pr } = this;
		if (!pr) {
			throw new Error('Unexpectedly no PR when trying to close');
		}
		try {
			const result: CloseResult = await this.postMessage({ command: 'pr.close', args: body });
			let events: TimelineEvent[] = [...pr.events];
			if (result.commentEvent) {
				events.push(result.commentEvent);
			}
			if (result.closeEvent) {
				events.push(result.closeEvent);
			}
			this.updatePR({
				events,
				pendingCommentText: '',
				state: result.state
			});
		} catch (_) {
			// Ignore
		}
	};

	public removeLabel = async (label: string) => {
		const { pr } = this;
		if (!pr) {
			throw new Error('Unexpectedly no PR when trying to remove label');
		}
		await this.postMessage({ command: 'pr.remove-label', args: label });
		const labels = pr.labels.filter(r => r.name !== label);
		this.updatePR({ labels });
	};

	public applyPatch = async (comment: IComment) => {
		this.postMessage({ command: 'pr.apply-patch', args: { comment } });
	};

	private appendReview(reply: SubmitReviewReply) {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to append review');
		}
		const { events, reviewers, reviewedEvent } = reply;
		state.busy = false;
		if (!events) {
			this.updatePR(state);
			return;
		}
		if (reviewers) {
			state.reviewers = reviewers;
		}
		state.events = events.length === 0 ? [...state.events, reviewedEvent] : events;
		if (reviewedEvent.event === EventType.Reviewed) {
			state.currentUserReviewState = reviewedEvent.state;
		}
		state.pendingCommentText = '';
		state.pendingReviewType = undefined;
		this.updatePR(state);
	}

	public reRequestReview = async (reviewerId: string) => {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to re-request review');
		}
		const { reviewers } = await this.postMessage({ command: 'pr.re-request-review', args: reviewerId });
		state.reviewers = reviewers;
		this.updatePR(state);
	}

	public async updateAutoMerge({ autoMerge, autoMergeMethod }: { autoMerge?: boolean, autoMergeMethod?: MergeMethod }) {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to update auto merge');
		}
		const response: { autoMerge: boolean, autoMergeMethod?: MergeMethod } = await this.postMessage({ command: 'pr.update-automerge', args: { autoMerge, autoMergeMethod } });
		state.autoMerge = response.autoMerge;
		state.autoMergeMethod = response.autoMergeMethod;
		this.updatePR(state);
	}

	public updateBranch = async () => {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to update branch');
		}
		const result: Partial<PullRequest> = await this.postMessage({ command: 'pr.update-branch' });
		state.events = result.events ?? state.events;
		state.mergeable = result.mergeable ?? state.mergeable;
		this.updatePR(state);
	}

	public dequeue = async () => {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to dequeue');
		}
		const isDequeued = await this.postMessage({ command: 'pr.dequeue' });
		if (isDequeued) {
			state.mergeQueueEntry = undefined;
		}
		this.updatePR(state);
	}

	public enqueue = async () => {
		const { pr: state } = this;
		if (!state) {
			throw new Error('Unexpectedly no PR when trying to enqueue');
		}
		const result = await this.postMessage({ command: 'pr.enqueue' });
		if (result.mergeQueueEntry) {
			state.mergeQueueEntry = result.mergeQueueEntry;
		}
		this.updatePR(state);
	}

	public openDiff = (comment: IComment) => this.postMessage({ command: 'pr.open-diff', args: { comment } });

	public toggleResolveComment = (threadId: string, thread: IComment[], newResolved: boolean) => {
		this.postMessage({
			command: 'pr.resolve-comment-thread',
			args: { threadId: threadId, toResolve: newResolved, thread }
		}).then((timelineEvents: TimelineEvent[] | undefined) => {
			if (timelineEvents) {
				this.updatePR({ events: timelineEvents });
			}
			else {
				this.refresh();
			}
		});
	};

	public openSessionLog = (link: SessionLinkInfo) => this.postMessage({ command: 'pr.open-session-log', args: { link } });

	public openCommitChanges = async (commitSha: string) => {
		this.updatePR({ loadingCommit: commitSha });
		try {
			await this.postMessage({ command: 'pr.openCommitChanges', args: { commitSha } as OpenCommitChangesArgs });
		} finally {
			this.updatePR({ loadingCommit: undefined });
		}
	};

	setPR = (pr: PullRequest | undefined) => {
		this.pr = pr;
		setState(this.pr);
		if (this.onchange) {
			this.onchange(this.pr);
		}
		return this;
	};

	updatePR = (pr: Partial<PullRequest> | undefined) => {
		updateState(pr);
		this.pr = this.pr ? { ...this.pr, ...pr } : pr as PullRequest;
		if (this.onchange) {
			this.onchange(this.pr);
		}
		return this;
	};

	postMessage(message: any) {
		return (this._handler?.postMessage(message) ?? Promise.resolve(undefined));
	}

	handleMessage = (message: any) => {
		switch (message.command) {
			case 'pr.clear':
				this.setPR(undefined);
				return;
			case 'pr.initialize':
				return this.setPR(message.pullrequest);
			case 'update-state':
				return this.updatePR({ state: message.state });
			case 'pr.update-checkout-status':
				return this.updatePR({ isCurrentlyCheckedOut: message.isCurrentlyCheckedOut });
			case 'pr.deleteBranch':
				const stateChange: { isLocalHeadDeleted?: boolean, isRemoteHeadDeleted?: boolean } = {};
				message.branchTypes && message.branchTypes.map((branchType: string) => {
					if (branchType === 'local') {
						stateChange.isLocalHeadDeleted = true;
					} else if ((branchType === 'remote') || (branchType === 'upstream')) {
						stateChange.isRemoteHeadDeleted = true;
					}
				});
				return this.updatePR(stateChange);
			case 'pr.enable-exit':
				return this.updatePR({ isCurrentlyCheckedOut: true });
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
				return;
			case 'pr.scrollToPendingReview':
				const pendingReview = document.getElementById('pending-review') ?? document.getElementById('comment-textarea');
				if (pendingReview) {
					pendingReview.scrollIntoView();
					pendingReview.focus();
				}
				return;
			case 'pr.submitting-review':
				return this.updatePR({ busy: true, lastReviewType: message.lastReviewType });
			case 'pr.append-review':
				return this.appendReview(message);
		}
	};

	public static instance = new PRContext();
}

const PullRequestContext = createContext<PRContext>(PRContext.instance);
export default PullRequestContext;
