/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext } from 'react';
import { IComment } from '../../src/common/comment';
import { EventType, ReviewEvent, TimelineEvent } from '../../src/common/timelineEvent';
import { MergeMethod, ReviewState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
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

	public copyPrLink = () => this.postMessage({ command: 'pr.copy-prlink' });

	public copyVscodeDevLink = () => this.postMessage({ command: 'pr.copy-vscodedevlink' });

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

	public refresh = () => this.postMessage({ command: 'pr.refresh' });

	public checkMergeability = () => this.postMessage({ command: 'pr.checkMergeability' });

	public merge = (args: { title: string | undefined; description: string | undefined; method: MergeMethod }) =>
		this.postMessage({ command: 'pr.merge', args });

	public openOnGitHub = () => this.postMessage({ command: 'pr.openOnGitHub' });

	public deleteBranch = () => this.postMessage({ command: 'pr.deleteBranch' });

	public readyForReview = () => this.postMessage({ command: 'pr.readyForReview' });

	public comment = async (args: string) => {
		const result = await this.postMessage({ command: 'pr.comment', args });
		const newComment = result.value;
		newComment.event = EventType.Commented;
		this.updatePR({
			events: [...this.pr.events, newComment],
			pendingCommentText: '',
		});
	};

	public addReviewers = () => this.postMessage({ command: 'pr.change-reviewers' });
	public addMilestone = () => this.postMessage({ command: 'pr.add-milestone' });
	public removeMilestone = () => this.postMessage({ command: 'pr.remove-milestone' });
	public addAssignees = () => this.postMessage({ command: 'pr.change-assignees' });
	public addAssigneeYourself = () => this.postMessage({ command: 'pr.add-assignee-yourself' });
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

	public requestChanges = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.request-changes', args: body }));

	public approve = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.approve', args: body }));

	public submit = async (body: string) =>
		this.appendReview(await this.postMessage({ command: 'pr.submit', args: body }));

	public close = async (body?: string) => {
		try {
			this.appendReview(await this.postMessage({ command: 'pr.close', args: body }));
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

	private appendReview({ review, reviewers }: { review?: ReviewEvent, reviewers?: ReviewState[] }) {
		const state = this.pr;
		state.busy = false;
		if (!review || !reviewers) {
			this.updatePR(state);
			return;
		}
		const events = state.events.filter(e => e.event !== EventType.Reviewed || e.state.toLowerCase() !== 'pending');
		events.forEach(event => {
			if (event.event === EventType.Reviewed) {
				event.comments.forEach(c => (c.isDraft = false));
			}
		});
		state.reviewers = reviewers;
		state.events = [...state.events.filter(e => (e.event === EventType.Reviewed ? e.state !== 'PENDING' : e)), review];
		state.currentUserReviewState = review.state;
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
				const pendingReview = document.getElementById('pending-review');
				if (pendingReview) {
					pendingReview.scrollIntoView();
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
