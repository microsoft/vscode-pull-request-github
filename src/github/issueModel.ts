/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { IAccount, Issue, GithubItemStateEnum, IMilestone } from './interface';

export class IssueModel {
	public id: number;
	public graphNodeId: string;
	public number: number;
	public title: string;
	public html_url: string;
	public state: GithubItemStateEnum = GithubItemStateEnum.Open;
	public author: IAccount;
	public assignee: IAccount;
	public createdAt: string;
	public updatedAt: string;
	public milestone?: IMilestone;
	public readonly githubRepository: GitHubRepository;
	public readonly remote: Remote;
	public item: Issue;
	public bodyHTML?: string;

	constructor(githubRepository: GitHubRepository, remote: Remote, item: Issue) {
		this.githubRepository = githubRepository;
		this.remote = remote;
		this.item = item;
		this.update(item);
	}

	public get isOpen(): boolean {
		return this.state === GithubItemStateEnum.Open;
	}

	public get userAvatar(): string | undefined {
		if (this.item) {
			return this.item.user.avatarUrl;
		}

		return undefined;
	}

	public get userAvatarUri(): vscode.Uri | undefined {
		if (this.item) {
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

	public get body(): string {
		if (this.item) {
			return this.item.body;
		}
		return '';
	}

	protected updateState(state: string) {
		if (state.toLowerCase() === 'open') {
			this.state = GithubItemStateEnum.Open;
		} else {
			this.state = GithubItemStateEnum.Closed;
		}
	}

	update(issue: Issue): void {
		this.id = issue.id;
		this.graphNodeId = issue.graphNodeId;
		this.number = issue.number;
		this.title = issue.title;
		this.bodyHTML = issue.bodyHTML;
		this.html_url = issue.url;
		this.author = issue.user;
		this.milestone = issue.milestone;
		this.createdAt = issue.createdAt;

		this.updateState(issue.state);

		if (issue.assignee) {
			this.assignee = issue.assignee;
		}
	}

	equals(other: IssueModel | undefined): boolean {
		if (!other) {
			return false;
		}

		if (this.number !== other.number) {
			return false;
		}

		if (this.html_url !== other.html_url) {
			return false;
		}

		return true;
	}
}
