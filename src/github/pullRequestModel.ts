/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitHubRef } from '../common/githubRef';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { IAccount, IPullRequest, IPullRequestModel, PullRequestStateEnum } from './interface';

export class PullRequestModel implements IPullRequestModel {
	public prNumber: number;
	public title: string;
	public html_url: string;
	public state: PullRequestStateEnum = PullRequestStateEnum.Open;
	public commentCount: number;
	public commitCount: number;
	public author: IAccount;
	public assignee: IAccount;
	public createdAt: string;
	public updatedAt: string;
	public localBranchName?: string;

	public get isOpen(): boolean {
		return this.state === PullRequestStateEnum.Open;
	}
	public get isMerged(): boolean {
		return this.state === PullRequestStateEnum.Merged;
	}

	public get userAvatar(): string {
		if (this.prItem) {
			return this.prItem.user.avatar_url;
		}

		return null;
	}
	public get userAvatarUri(): vscode.Uri {
		if (this.prItem) {
			let key = this.userAvatar;
			let gravatar = vscode.Uri.parse(`${key}&s=${64}`);

			// hack, to ensure queries are not wrongly encoded.
			const originalToStringFn = gravatar.toString;
			gravatar.toString = function (skipEncoding?: boolean | undefined) {
				return originalToStringFn.call(gravatar, true);
			};

			return gravatar;
		}

		return null;
	}

	public get body(): string {
		if (this.prItem) {
			return this.prItem.body;
		}
		return null;
	}

	public head: GitHubRef;
	public base: GitHubRef;

	constructor(public readonly githubRepository: GitHubRepository, public readonly remote: Remote, public prItem: IPullRequest) {
		this.update(prItem);
	}

	update(prItem: IPullRequest): void {
		this.prNumber = prItem.number;
		this.title = prItem.title;
		this.html_url = prItem.html_url;
		this.author = {
			login: prItem.user.login,
			isUser: prItem.user.type === 'User',
			isEnterprise: prItem.user.type === 'Enterprise',
			avatarUrl: prItem.user.avatar_url,
			htmlUrl: prItem.user.html_url
		};

		switch (prItem.state) {
			case 'open':
				this.state = PullRequestStateEnum.Open;
				break;
			case 'merged':
				this.state = PullRequestStateEnum.Merged;
				break;
			case 'closed':
				this.state = PullRequestStateEnum.Closed;
				break;
		}

		if (prItem.assignee) {
			this.assignee = {
				login: prItem.assignee.login,
				isUser: prItem.assignee.type === 'User',
				isEnterprise: prItem.assignee.type === 'Enterprise',
				avatarUrl: prItem.assignee.avatar_url,
				htmlUrl: prItem.assignee.html_url
			};
		}

		this.createdAt = prItem.created_at;
		this.updatedAt = prItem.updated_at ? prItem.updated_at : this.createdAt;
		this.commentCount = prItem.comments;
		this.commitCount = prItem.commits;

		this.head = new GitHubRef(prItem.head.ref, prItem.head.label, prItem.head.sha, prItem.head.repo.clone_url);
		this.base = new GitHubRef(prItem.base.ref, prItem.base.label, prItem.base.sha, prItem.base.repo.clone_url);
	}

	equals(other: IPullRequestModel): boolean {
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
