/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CredentialStore } from "./credentials";
import { Comment } from "../common/comment";
import { Remote } from "../common/remote";
import { Repository } from "../common/repository";
import { TimelineEvent, EventType } from "../common/timelineEvent";
import { GitHubRepository, PULL_REQUEST_PAGE_SIZE } from "./githubRepository";
import { IPullRequestManager, IPullRequestModel, IPullRequestsPagingOptions, PRType, Commit, FileChange } from "./interface";
import { PullRequestGitHelper } from "./pullRequestGitHelper";
import { PullRequestModel } from "./pullRequestModel";
import { parserCommentDiffHunk } from "../common/diffHunk";
import { Configuration } from "../configuration";
import { formatError } from '../common/utils';

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

export class PullRequestManager implements IPullRequestManager {
	private _activePullRequest?: IPullRequestModel;
	private _credentialStore: CredentialStore;
	private _githubRepositories: GitHubRepository[];
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	constructor(private _configuration: Configuration, private _repository: Repository) {
		this._githubRepositories = [];
		this._credentialStore = new CredentialStore(this._configuration);
	}

	get activePullRequest() {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: IPullRequestModel) {
		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
	}

	async clearCredentialCache(): Promise<void> {
		this._credentialStore.reset();
	}

	async updateRepositories(): Promise<void> {
		const gitHubRemotes = this._repository.remotes.filter(remote => remote.host && remote.host.toLowerCase() === "github.com");
		if (gitHubRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
		} else {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', false);
		}

		let repositories = [];
		for (let remote of gitHubRemotes) {
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote.remoteName);
			if (!isRemoteForPR) {
				const octokit = await this._credentialStore.getOctokit(remote);
				if (octokit) {
					repositories.push(new GitHubRepository(remote, octokit));
				}
			}
		}

		this._githubRepositories = repositories;

		for (let repository of this._githubRepositories) {
			const remoteId = repository.remote.url.toString();
			if (!this._repositoryPageInformation.get(remoteId)) {
				this._repositoryPageInformation.set(remoteId, {
					pullRequestPage: 1,
					hasMorePages: null
				});
			}
		}

		return Promise.resolve();
	}

	async getLocalPullRequests(): Promise<IPullRequestModel[]> {
		let githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		let infos = await PullRequestGitHelper.getLocalBranchesAssociatedWithPullRequest(this._repository);
		let promises = infos.map(async info => {
			let owner = info.owner;
			let prNumber = info.prNumber;
			let githubRepo = githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

			if (!githubRepo) {
				return Promise.resolve([]);
			}

			return [await githubRepo.getPullRequest(prNumber)];
		});

		return await Promise.all(promises).then(values => {
			return values.reduce((prev, curr) => prev.concat(...curr), []).filter(value => value !== null);
		});
	}

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }): Promise<[IPullRequestModel[], boolean]> {
		let githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [[], false];
		}

		if (!options.fetchNextPage) {
			for (let repository of this._githubRepositories) {
				this._repositoryPageInformation.set(repository.remote.url.toString(), {
					pullRequestPage: 1,
					hasMorePages: null
				});
			}
		}

		githubRepositories = githubRepositories.filter(repo => this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);

		let pullRequests: PullRequestModel[] = [];
		let numPullRequests = 0;
		let hasMorePages = false;

		for (let i = 0; i < githubRepositories.length; i++) {
			if (numPullRequests >= PULL_REQUEST_PAGE_SIZE) {
				hasMorePages = true;
				break;
			}

			const githubRepository = githubRepositories[i];
			const remote = githubRepository.remote.remoteName;
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote);
			if (!isRemoteForPR) {
				const pageInformation = this._repositoryPageInformation.get(githubRepository.remote.url.toString());
				while (numPullRequests < PULL_REQUEST_PAGE_SIZE && pageInformation.hasMorePages !== false) {
					const pullRequestData = await githubRepository.getPullRequests(type, pageInformation.pullRequestPage);
					numPullRequests += pullRequestData.pullRequests.length;
					pullRequests = pullRequests.concat(...pullRequestData.pullRequests);

					pageInformation.hasMorePages = pullRequestData.hasMorePages;
					hasMorePages = hasMorePages || pageInformation.hasMorePages;
					pageInformation.pullRequestPage++;;
				}
			}
		}

		return [pullRequests, hasMorePages];
	}

	public mayHaveMorePages(): boolean {
		return this._githubRepositories.some(repo =>  this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);
	}

	async getPullRequestComments(pullRequest: IPullRequestModel): Promise<Comment[]> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const reviewData = await octokit.pullRequests.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		const rawComments = reviewData.data;
		return parserCommentDiffHunk(rawComments);
	}

	async getPullRequestCommits(pullRequest: IPullRequestModel): Promise<Commit[]> {
		try {
			const { octokit, remote } = (pullRequest as PullRequestModel).githubRepository;
			const commitData = await octokit.pullRequests.getCommits({
					number: pullRequest.prNumber,
					owner: remote.owner,
					repo: remote.repositoryName
			});

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: IPullRequestModel, commit: Commit): Promise<FileChange[]> {
		try {
			const { octokit, remote } = (pullRequest as PullRequestModel).githubRepository;
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				sha: commit.sha
			});

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getReviewComments(pullRequest: IPullRequestModel, reviewId: string): Promise<Comment[]> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const reviewData = await octokit.pullRequests.getReviewComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			id: reviewId,
			review_id: reviewId
		});

		const rawComments = reviewData.data;
		return parserCommentDiffHunk(rawComments);
	}

	async getTimelineEvents(pullRequest: IPullRequestModel): Promise<TimelineEvent[]> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		let ret = await octokit.issues.getEventsTimeline({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: pullRequest.prNumber,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return await parseTimelineEvents(this, pullRequest, ret.data);
	}

	async getIssueComments(pullRequest: IPullRequestModel): Promise<Comment[]> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const promise = await octokit.issues.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return promise.data;
	}

	async createIssueComment(pullRequest: IPullRequestModel, text: string): Promise<Comment> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const promise = await octokit.issues.createComment({
			body: text,
			number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return promise.data;
	}

	async createCommentReply(pullRequest: IPullRequestModel, body: string, reply_to: string) {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		let ret = await octokit.pullRequests.createCommentReply({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			body: body,
			in_reply_to: Number(reply_to)
		});

		return ret;
	}

	async createComment(pullRequest: IPullRequestModel, body: string, path: string, position: number) {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		let ret = await octokit.pullRequests.createComment({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			body: body,
			commit_id: pullRequest.head.sha,
			path: path,
			position: position
		});

		return ret;
	}

	async closePullRequest(pullRequest: IPullRequestModel): Promise<any> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		let ret = await octokit.pullRequests.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			state: 'closed'
		});

		return ret.data;
	}

	async getPullRequestChangedFiles(pullRequest: IPullRequestModel): Promise<FileChange[]> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const { data } = await octokit.pullRequests.getFiles({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber
		});

		const largeChanges = data.filter(fileChange => !fileChange.patch);
		if (largeChanges.length) {
			const fileNames = largeChanges.map(change => change.filename).join(', ');
			vscode.window.showInformationMessage(`This pull request contains file changes that are too large to load: ${fileNames}`, 'Open in GitHub').then(result => {
				if (result === 'Open in GitHub') {
					vscode.commands.executeCommand('pr.openPullRequestInGitHub', pullRequest);
				}
			});
		}

		return data.filter(fileChange => !!fileChange.patch);
	}

	async fullfillPullRequestCommitInfo(pullRequest: IPullRequestModel): Promise<void> {
		if (!pullRequest.base) {
			// this one is from search results, which is not complete.
			let githubRepository = (pullRequest as PullRequestModel).githubRepository;
			let octokit = githubRepository.octokit;
			let remote = githubRepository.remote;

			const { data } = await octokit.pullRequests.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber
			});
			pullRequest.update(data);
		}
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<IPullRequestModel> {
		const githubRepo = this._githubRepositories.find(repo =>
			repo.remote.owner.toLowerCase() === owner && repo.remote.repositoryName.toLowerCase() === repositoryName
		);

		if (!githubRepo) {
			return null;
		}

		const pr = await githubRepo.getPullRequest(pullReuqestNumber);
		return pr;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this._repository || !this._repository.HEAD) {
			return null;
		}

		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, this._repository.HEAD.name);
		return matchingPullRequestMetadata;
	}

	async getBranchForPullRequestFromExistingRemotes(pullRequest: IPullRequestModel) {
		return await PullRequestGitHelper.getBranchForPullRequestFromExistingRemotes(this._repository, this._githubRepositories,pullRequest);
	}

	async checkout(remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.checkout(this._repository, remote, branchName, pullRequest);
	}

	async createAndCheckout(pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.createAndCheckout(this._repository, pullRequest);
	}

	//#endregion
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

export async function parseTimelineEvents(pullRequestManager: IPullRequestManager, pullRequest: IPullRequestModel, events: any[]): Promise<TimelineEvent[]> {
	events.forEach(event => {
		let type = getEventType(event.event);
		event.event = type;
		return event;
	});

	await Promise.all(
		events.filter(event => event.event === EventType.Reviewed)
			.map(event => pullRequestManager.getReviewComments(pullRequest, event.id).then(result => {
				event.comments = result;
			})));

	return events;
}