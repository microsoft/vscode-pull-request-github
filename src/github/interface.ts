import * as vscode from 'vscode';
import { GitHubRef } from "../common/githubRef";
import { Comment } from "../common/comment";
import { TimelineEvent } from "../common/timelineEvent";
import { Remote } from "../common/remote";

export enum PRType {
	RequestReview = 0,
	AssignedToMe = 1,
	Mine = 2,
	Mention = 3,
	All = 4,
	LocalPullRequest = 5
}

export enum ReviewEvent {
	Approve = "APPROVE",
	RequestChanges = "REQUEST_CHANGES",
	Comment = "COMMENT"
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

export interface IRepository {
	label: string;
	ref: string;
	repo: any;
	sha: string;
}

// This interface is incomplete
export interface IPullRequest {
	additions: number;
	assignee: any;
	assignees: any[];
	author_association: string;
	base: IRepository;
	body: string;
	changed_files: number;
	closed_at: string;
	comments: number;
	commits: number;
	created_at: string;
	head: IRepository;
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

export interface FileChange {
	additions: number;
	blob_url: string;
	changes: number;
	contents_url: string;
	deletions: number;
	filename: string;
	patch?: string;
	raw_url: string;
	sha: string;
	status: string;
}

export interface Commit {
	author: {
		login: string;
	};
	commit: {
		author: {
			name: string;
			date: string;
			email: string;
		};
		message: string;
	};
	html_url: string;
	sha: string;
	parents: any;
}

export interface IPullRequestModel {
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
	localBranchName?: string;
	userAvatar: string;
	userAvatarUri: vscode.Uri;
	body: string;
	update(prItem: IPullRequest): void;
	equals(other: IPullRequestModel): boolean;
}

export interface IPullRequestsPagingOptions {
	fetchNextPage: boolean;
}

export interface IPullRequestManager {
	activePullRequest?: IPullRequestModel;
	readonly onDidChangeActivePullRequest: vscode.Event<void>;
	getLocalPullRequests(): Promise<IPullRequestModel[]>;
	deleteLocalPullRequest(pullRequest: IPullRequestModel): Promise<void>;
	getPullRequests(type: PRType, options?: IPullRequestsPagingOptions):Promise<[IPullRequestModel[], boolean]>;
	mayHaveMorePages(): boolean;
	getPullRequestComments(pullRequest: IPullRequestModel): Promise<Comment[]>;
	getPullRequestCommits(pullRequest: IPullRequestModel): Promise<Commit[]>;
	getCommitChangedFiles(pullRequest: IPullRequestModel, commit: Commit): Promise<FileChange[]>;
	getReviewComments(pullRequest: IPullRequestModel, reviewId: string): Promise<Comment[]>;
	getTimelineEvents(pullRequest: IPullRequestModel): Promise<TimelineEvent[]>;
	getIssueComments(pullRequest: IPullRequestModel): Promise<Comment[]>;
	createIssueComment(pullRequest: IPullRequestModel, text: string): Promise<Comment>;
	createCommentReply(pullRequest: IPullRequestModel, body: string, reply_to: string): Promise<Comment>;
	createComment(pullRequest: IPullRequestModel, body: string, path: string, position: number): Promise<Comment>;
	closePullRequest(pullRequest: IPullRequestModel): Promise<any>;
	approvePullRequest(pullRequest: IPullRequestModel, message?: string): Promise<any>;
	requestChanges(pullRequest: IPullRequestModel, message?: string): Promise<any>;
	getPullRequestChangedFiles(pullRequest: IPullRequestModel): Promise<FileChange[]>;
	getPullRequestRepositoryDefaultBranch(pullRequest: IPullRequestModel): Promise<string>;

	fullfillPullRequestCommitInfo(pullRequest: IPullRequestModel): Promise<void>;
	updateRepositories(): Promise<void>;

	/**
	 * git related APIs
	 */

	resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<IPullRequestModel>;
	getMatchingPullRequestMetadataForBranch();
	getBranchForPullRequestFromExistingRemotes(pullRequest: IPullRequestModel);
	checkout(remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void>;
	createAndCheckout(pullRequest: IPullRequestModel): Promise<void>;

}