/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitHubRef } from '../common/githubRef';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { PullRequest, GithubItemStateEnum, ISuggestedReviewer } from './interface';
import { IssueModel } from './issueModel';

interface IPullRequestModel {
	head: GitHubRef | null;
}

export interface IResolvedPullRequestModel extends IPullRequestModel {
	head: GitHubRef;
}

export class PullRequestModel extends IssueModel implements IPullRequestModel {
	public isDraft?: boolean;
	public item: PullRequest;
	public localBranchName?: string;
	public mergeBase?: string;
	public suggestedReviewers?: ISuggestedReviewer[];
	private _inDraftMode: boolean = false;
	private _onDidChangeDraftMode: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
	public onDidChangeDraftMode = this._onDidChangeDraftMode.event;

	constructor(githubRepository: GitHubRepository, remote: Remote, item: PullRequest) {
		super(githubRepository, remote, item);
	}

	public get isMerged(): boolean {
		return this.state === GithubItemStateEnum.Merged;
	}

	public get inDraftMode(): boolean {
		return this._inDraftMode;
	}

	public set inDraftMode(inDraftMode: boolean) {
		if (this._inDraftMode !== inDraftMode) {
			this._inDraftMode = inDraftMode;
			this._onDidChangeDraftMode.fire(this._inDraftMode);
		}
	}

	public head: GitHubRef | null;
	public base: GitHubRef;

	protected updateState(state: string) {
		if (state.toLowerCase() === 'open') {
			this.state = GithubItemStateEnum.Open;
		} else {
			this.state = this.item.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Closed;
		}
	}

	update(item: PullRequest): void {
		super.update(item);
		this.isDraft = item.isDraft;
		this.suggestedReviewers = item.suggestedReviewers;

		if (item.head) {
			this.head = new GitHubRef(item.head.ref, item.head.label, item.head.sha, item.head.repo.cloneUrl);
		}

		if (item.base) {
			this.base = new GitHubRef(item.base.ref, item.base!.label, item.base!.sha, item.base!.repo.cloneUrl);
		}
	}

	/**
	 * Validate if the pull request has a valid HEAD.
	 * Use only when the method can fail silently, otherwise use `validatePullRequestModel`
	 */
	isResolved(): this is IResolvedPullRequestModel {
		return !!this.head;
	}

	/**
	 * Validate if the pull request has a valid HEAD. Show a warning message to users when the pull request is invalid.
	 * @param message Human readable action execution failure message.
	 */
	validatePullRequestModel(message?: string): this is IResolvedPullRequestModel {
		if (!!this.head) {
			return true;
		}

		const reason = `There is no upstream branch for Pull Request #${this.number}. View it on GitHub for more details`;

		if (message) {
			message += `: ${reason}`;
		} else {
			message = reason;
		}

		vscode.window.showWarningMessage(message, 'Open in GitHub').then(action => {
			if (action && action === 'Open in GitHub') {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(this.html_url));
			}
		});

		return false;
	}
}
