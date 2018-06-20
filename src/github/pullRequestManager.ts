/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPullRequestModel, PRType } from "./interface";
import { Repository } from "../models/repository";
import { GitHubRepository } from "./githubRepository";
import { CredentialStore } from "../credentials";
import { PullRequestGitHelper } from "./pullRequestGitHelper";
import { Comment } from "../models/comment";
import { parseTimelineEvents, TimelineEvent } from "../models/timelineEvent";
import { IPullRequestManager, IPullRequestsPagingOptions } from "./interface";
import { PullRequestModel } from "./pullRequestModel";
import { parserCommentDiffHunk } from "../common/diff";
import { Remote } from "../models/remote";


export class PullRequestManager implements IPullRequestManager {
	public activePullRequest?: IPullRequestModel;
	private _githubRepositories: GitHubRepository[];

	constructor(private _credentialStore: CredentialStore, private _repository: Repository) {
		this._githubRepositories = [];
	}

	async initialize(): Promise<void> {
		let ret: GitHubRepository[] = [];
		await Promise.all(this._repository.remotes.map(async remote => {
			let isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote.remoteName);
			if (isRemoteForPR) {
				return;
			}

			let octo = await this._credentialStore.getOctokit(remote);

			if (octo) {
				ret.push(new GitHubRepository(remote, octo));
			}
		}));

		this._githubRepositories = ret;
	}

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { page: 1, pageSize: 30 }): Promise<IPullRequestModel[]> {
		let githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		if (type === PRType.LocalPullRequest) {
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

			return Promise.all(promises).then(values => {
				return values.reduce((prev, curr) => prev.concat(...curr), []).filter(value => value !== null);
			});
		}

		let promises = githubRepositories.map(async githubRepository => {
			let remote = githubRepository.remote.remoteName;
			let isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote);
			if (isRemoteForPR) {
				return Promise.resolve([]);
			}
			return [await githubRepository.getPullRequests(type)];
		});

		return Promise.all(promises).then(values => {
			return values.reduce((prev, curr) => prev.concat(...curr), []);
		});
	}

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
		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, this._repository.HEAD.name);
		return matchingPullRequestMetadata;
	}

	async getBranchForPullRequestFromExistingRemotes(pullRequest: IPullRequestModel) {
		return await PullRequestGitHelper.getBranchForPullRequestFromExistingRemotes(this._repository, pullRequest);
	}

	async checkout(remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.checkout(this._repository, remote, branchName, pullRequest);
	}

	async createAndCheckout(pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.createAndCheckout(this._repository, pullRequest);
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

	async getPullRequestChagnedFiles(pullRequest: IPullRequestModel): Promise<any> {
		let githubRepository = (pullRequest as PullRequestModel).githubRepository;
		let octokit = githubRepository.octokit;
		let remote = githubRepository.remote;

		const { data } = await octokit.pullRequests.getFiles({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber
		});

		return data;
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
}