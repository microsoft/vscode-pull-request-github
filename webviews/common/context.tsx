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
		public pr: PullRequest = getState(),
		public onchange: ((ctx: PullRequest) => void) | null = null,
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
		this.pr.busy = true;
		this.updatePR(this.pr);
		await this.postMessage({ command: 'pr.refresh' });
		this.pr.busy = false;
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
		this.pr.events.splice(index, 1, {
			...review,
			comments: review.comments.filter(c => c.id !== id),
		});
		this.updatePR(this.pr);
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
		try {
			const result: CloseResult = await this.postMessage({ command: 'pr.close', args: body });
			let events: TimelineEvent[] = [...this.pr.events];
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
		await this.postMessage({ command: 'pr.remove-label', args: label });
		const labels = this.pr.labels.filter(r => r.name !== label);
		this.updatePR({ labels });
	};

	public applyPatch = async (comment: IComment) => {
		this.postMessage({ command: 'pr.apply-patch', args: { comment } });
	};

	private appendReview(reply: SubmitReviewReply) {
		const { events, reviewers, reviewedEvent } = reply;
		const state = this.pr;
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
		const { reviewers } = await this.postMessage({ command: 'pr.re-request-review', args: reviewerId });
		const state = this.pr;
		state.reviewers = reviewers;
		this.updatePR(state);
	}

	public async updateAutoMerge({ autoMerge, autoMergeMethod }: { autoMerge?: boolean, autoMergeMethod?: MergeMethod }) {
		const response: { autoMerge: boolean, autoMergeMethod?: MergeMethod } = await this.postMessage({ command: 'pr.update-automerge', args: { autoMerge, autoMergeMethod } });
		const state = this.pr;
		state.autoMerge = response.autoMerge;
		state.autoMergeMethod = response.autoMergeMethod;
		this.updatePR(state);
	}

	public updateBranch = async () => {
		const result: Partial<PullRequest> = await this.postMessage({ command: 'pr.update-branch' });
		const state = this.pr;
		state.events = result.events ?? state.events;
		state.mergeable = result.mergeable ?? state.mergeable;
		this.updatePR(state);
	}

	public dequeue = async () => {
		const isDequeued = await this.postMessage({ command: 'pr.dequeue' });
		const state = this.pr;
		if (isDequeued) {
			state.mergeQueueEntry = undefined;
		}
		this.updatePR(state);
	}

	public enqueue = async () => {
		const result = await this.postMessage({ command: 'pr.enqueue' });
		const state = this.pr;
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

	public openCommitChanges = (commitSha: string) => this.postMessage({ command: 'pr.openCommitChanges', args: { commitSha } as OpenCommitChangesArgs });

	setPR = (pr: PullRequest) => {
		this.pr = pr;
		setState(this.pr);
		if (this.onchange) {
			this.onchange(this.pr);
		}
		return this;
	};

	updatePR = (pr: Partial<PullRequest>) => {
		updateState(pr);
		this.pr = { ...this.pr, ...pr };
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
