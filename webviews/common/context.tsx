/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Comment,
	GitPullRequestCommentThread,
	GitPullRequestMergeStrategy,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createContext } from 'react';
import { MergeMethod } from '../../src/azdo/interface';
import { ReviewEvent } from '../../src/common/timelineEvent';
import { getState, PullRequest, setState, updateState } from './cache';
import { getMessageHandler, MessageHandler } from './message';

export class PRContext {
	constructor(
		public pr: PullRequest = getState(),
		public onchange: ((ctx: PullRequest) => void) | null = null,
		private _handler: MessageHandler = null,
	) {
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	public setTitle = (title: string) => this.postMessage({ command: 'pr.edit-title', args: { text: title } });

	public setDescription = (description: string) =>
		this.postMessage({ command: 'pr.edit-description', args: { text: description } });

	public checkout = () => this.postMessage({ command: 'pr.checkout' });

	public copyPrLink = () => this.postMessage({ command: 'pr.copy-prlink' });

	public exitReviewMode = async () => {
		if (!this.pr) {
			return;
		}
		return this.postMessage({
			command: 'pr.checkout-default-branch',
			args: this.pr.repositoryDefaultBranch,
		});
	};

	public refresh = () => this.postMessage({ command: 'pr.refresh' });

	public checkMergeability = () => this.postMessage({ command: 'pr.checkMergeability' });

	public merge = (args: { title: string; description: string; method: MergeMethod }) =>
		this.postMessage({ command: 'azdopr.merge', args });

	public deleteBranch = () => this.postMessage({ command: 'pr.deleteBranch' });

	public readyForReview = () => this.postMessage({ command: 'azdopr.readyForReview' });

	public replyThread = async (body: string, thread: GitPullRequestCommentThread) => {
		const result = await this.postMessage({ command: 'pr.reply-thread', args: { text: body, threadId: thread.id } });
		thread.comments.push(result.comment);
		this.updatePR({
			threads: [...this.pr.threads.filter(t => t.id !== thread.id), thread],
		});
	};

	public comment = async (args: string) => {
		const result = await this.postMessage({ command: 'pr.comment', args });
		const thread = result.thread;
		this.updatePR({
			threads: [...this.pr.threads, thread],
		});
	};

	public changeThreadStatus = async (status: number, thread: GitPullRequestCommentThread) => {
		const result = await this.postMessage({
			command: 'pr.change-thread-status',
			args: { status: status, threadId: thread.id },
		});
		const updatedThread = result.thread;
		this.updatePR({
			threads: [...this.pr.threads.filter(t => t.id !== updatedThread?.id), updatedThread],
		});
	};

	public addOptionalReviewers = async () => {
		this.appendReview(await this.postMessage({ command: 'pr.add-reviewers', args: { isRequired: false } }));
	};

	public addRequiredReviewers = async () => {
		this.appendReview(await this.postMessage({ command: 'pr.add-reviewers', args: { isRequired: true } }));
	};

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

	public editComment = (args: { comment: Comment; threadId: number; text: string }) =>
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

	public votePullRequest = async (body: number) =>
		this.appendReview(await this.postMessage({ command: 'pr.vote', args: body }));

	public submit = async (body: string) => this.appendReview(await this.postMessage({ command: 'pr.submit', args: body }));

	public close = async (body?: string) => {
		try {
			this.appendReview(await this.postMessage({ command: 'azdopr.close', args: body }));
		} catch (_) {
			// Ignore
		}
	};

	public complete = async (args: { deleteSourceBranch: boolean; completeWorkitem: boolean; mergeStrategy: string }) => {
		const options = { ...args, mergeStrategy: GitPullRequestMergeStrategy[args.mergeStrategy] };
		const result = await this.postMessage({ command: 'pr.complete', args: options });
		this.updatePR(result);
	};

	public removeReviewer = async (id: string) => {
		const res = await this.postMessage({ command: 'pr.remove-reviewer', args: { id: id } });
		this.appendReview(res);
	};

	public associateWorkItem = async () => {
		const res = await this.postMessage({ command: 'pr.associate-workItem' });
		if (!!res) {
			const workItems = [...this.pr.workItems, res];
			this.updatePR({ workItems });
		}
	};

	public removeWorkItemFromPR = async (id: number) => {
		const res = await this.postMessage({ command: 'pr.remove-workItem', args: this.pr.workItems.find(w => w.id === id) });
		if (!!res.success) {
			const workItems = this.pr.workItems.filter(r => r.id !== id);
			this.updatePR({ workItems });
		}
	};

	public applyPatch = async (commentContent: string, commentId: number, threadId: number) => {
		this.postMessage({
			command: 'pr.apply-patch',
			args: { content: commentContent, commentId: commentId, threadId: threadId },
		});
	};

	private appendReview({ review, reviewers }: any) {
		const state = this.pr;
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		review;
		state.reviewers = reviewers;
		this.updatePR(state);
	}

	public openDiff = (thread: GitPullRequestCommentThread) => this.postMessage({ command: 'pr.open-diff', args: { thread } });

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
		return this._handler.postMessage(message);
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
				return this.updatePR({ head: 'UNKNOWN' });
			case 'pr.enable-exit':
				return this.updatePR({ isCurrentlyCheckedOut: true });
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		}
	};

	public static instance = new PRContext();
}

const PullRequestContext = createContext<PRContext>(PRContext.instance);
export default PullRequestContext;
