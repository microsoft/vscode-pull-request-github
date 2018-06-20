/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitHubRef } from './githubRef';
import { Remote } from '../models/remote';
import { GitHubRepository } from './githubRepository';

export enum PRType {
	RequestReview = 0,
	ReviewedByMe = 1,
	Mine = 2,
	Mention = 3,
	All = 4,
	LocalPullRequest = 5
}

export enum PullRequestStateEnum {
	Open,
	Merged,
	Closed,
}

export interface IAccount {
	login: string;
	isUser: boolean;
	isEnterprise: boolean;
	avatarUrl: string;
	htmlUrl: string;
	ownedPrivateRepositoryCount?: number;
	privateRepositoryInPlanCount?: number;
}

export interface Repo {
	label: string;
	ref: string;
	repo: any;
	sha: string;
}

// This interface is incomplete
export interface PullRequest {
	additions: number;
	assignee: any;
	assignees: any[];
	author_association: string;
	base: Repo;
	body: string;
	changed_files: number;
	closed_at: string;
	comments: number;
	commits: number;
	created_at: string;
	head: Repo;
	html_url: string;
	id: number;
	labels: any[];
	locked: boolean;
	maintainer_can_modify: boolean;
	merge_commit_sha; boolean;
	mergable: boolean;
	number: number;
	rebaseable: boolean;
	state: string;
	title: string;
	updated_at: string;
	user: any;
}

export interface IPullRequestModel {
	githubRepository: GitHubRepository;
	prNumber: number;
	title: string;
	html_url: string;
	state: PullRequestStateEnum;
	commentCount: number;
	commitCount: number;
	author: IAccount;
	assignee: IAccount;
	createdAt: string;
	updatedAt: string;
	isOpen: boolean;
	isMerged: boolean;
	head?: GitHubRef;
	base?: GitHubRef;
	userAvatar: string;
	body: string;
	update(prItem: PullRequest): void;
	equals(other: IPullRequestModel): boolean;
}

export class PullRequestModel implements PullRequestModel {
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

	public get body(): string {
		if (this.prItem) {
			return this.prItem.body;
		}
		return null;
	}

	public head: GitHubRef;
	public base: GitHubRef;

	constructor(public readonly githubRepository: GitHubRepository, public readonly remote: Remote, public prItem: PullRequest) {
		this.update(prItem);
	}

	update(prItem: PullRequest): void {
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
