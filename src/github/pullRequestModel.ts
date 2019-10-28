/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitHubRef } from '../common/githubRef';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { IAccount, PullRequest, PullRequestStateEnum } from './interface';

interface IPullRequestModel {
	head: GitHubRef | null;
}

export interface IResolvedPullRequestModel extends IPullRequestModel {
	head: GitHubRef;
}

export class PullRequestModel implements IPullRequestModel {
	public id: number;
	public graphNodeId: string;
	public prNumber: number;
	public title: string;
	public html_url: string;
	public state: PullRequestStateEnum = PullRequestStateEnum.Open;
	public author: IAccount;
	public assignee: IAccount;
	public createdAt: string;
	public updatedAt: string;
	public localBranchName?: string;
	public mergeBase?: string;
	public isDraft: boolean;

	public get isOpen(): boolean {
		return this.state === PullRequestStateEnum.Open;
	}
	public get isMerged(): boolean {
		return this.state === PullRequestStateEnum.Merged;
	}

	public get userAvatar(): string | undefined {
		if (this.prItem) {
			return this.prItem.user.avatarUrl;
		}

		return undefined;
	}
	public get userAvatarUri(): vscode.Uri | undefined {
		if (this.prItem) {
			const key = this.userAvatar;
			if (key) {
				const uri = vscode.Uri.parse(`${key}&s=${64}`);

				// hack, to ensure queries are not wrongly encoded.
				const originalToStringFn = uri.toString;
				uri.toString = function (skipEncoding?: boolean | undefined) {
					return originalToStringFn.call(uri, true);
				};

				return uri;
			}
		}

		return undefined;
	}

	private _inDraftMode: boolean = false;

	public get inDraftMode(): boolean {
		return this._inDraftMode;
	}

	public set inDraftMode(inDraftMode: boolean) {
		if (this._inDraftMode !== inDraftMode) {
			this._inDraftMode = inDraftMode;
			this._onDidChangeDraftMode.fire(this._inDraftMode);
		}
	}

	private _onDidChangeDraftMode: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
	public onDidChangeDraftMode = this._onDidChangeDraftMode.event;

	public get body(): string {
		if (this.prItem) {
			return this.prItem.body;
		}
		return '';
	}

	public bodyHTML?: string;

	public head: GitHubRef | null;
	public base: GitHubRef;

	constructor(public readonly githubRepository: GitHubRepository, public readonly remote: Remote, public prItem: PullRequest) {
		this.update(prItem);
	}

	update(prItem: PullRequest): void {
		this.id = prItem.id;
		this.graphNodeId = prItem.graphNodeId;
		this.prNumber = prItem.number;
		this.title = prItem.title;
		this.bodyHTML = prItem.bodyHTML;
		this.html_url = prItem.url;
		this.author = prItem.user;
		this.isDraft = prItem.isDraft;

		if (prItem.state.toLowerCase() === 'open') {
			this.state = PullRequestStateEnum.Open;
		} else {
			this.state = prItem.merged ? PullRequestStateEnum.Merged : PullRequestStateEnum.Closed;
		}

		if (prItem.assignee) {
			this.assignee = prItem.assignee;
		}

		this.createdAt = prItem.createdAt;
		this.updatedAt = prItem.updatedAt ? prItem.updatedAt : this.createdAt;

		if (prItem.head) {
			this.head = new GitHubRef(prItem.head.ref, prItem.head.label, prItem.head.sha, prItem.head.repo.cloneUrl);
		}

		if (prItem.base) {
			this.base = new GitHubRef(prItem.base.ref, prItem.base!.label, prItem.base!.sha, prItem.base!.repo.cloneUrl);
		}
	}

	/**
	 * Valiate if the pull request has a valid HEAD.
	 * Use only when the method can fail sliently, otherwise use `validatePullRequestModel`
	 */
	isResolved(): this is IResolvedPullRequestModel {
		return !!this.head;
	}

	/**
	 * Valiate if the pull request has a valid HEAD. Show a warning message to users when the pull request is invalid.
	 * @param message Human readable action execution failure message.
	 */
	validatePullRequestModel(message?: string): this is IResolvedPullRequestModel {
		if (!!this.head) {
			return true;
		}

		const reason = `There is no upstream branch for Pull Request #${this.prNumber}. View it on GitHub for more details`;

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

	equals(other: PullRequestModel | undefined): boolean {
		if (!other) {
			return false;
		}

		if (this.prNumber !== other.prNumber) {
			return false;
		}

		if (this.html_url !== other.html_url) {
			return false;
		}

		return true;
	}
}
