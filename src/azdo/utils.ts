import { IdentityRef } from "azure-devops-node-api/interfaces/common/VSSInterfaces";
import { GitBranchStats, GitPullRequest, PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces";
import { AzdoRepository } from "./azdoRepository";
import { IAccount, PullRequest, PullRequestMergeability, IGitHubRef } from "./interface";


export function convertAzdoPullRequestToRawPullRequest(pullRequest: GitPullRequest, azdoRepo: AzdoRepository): PullRequest {
	const {
		pullRequestId,
		description,
		title,
		url,
		createdBy,
		status,
		reviewers,
		creationDate,
		sourceRefName,
		targetRefName,
		isDraft,
		mergeStatus
	} = pullRequest;

	const item: PullRequest = {
		id: pullRequestId,
		number: pullRequestId,
		body: description,
		title: title,
		url: url,
		user: !!createdBy ? convertRESTUserToAccount(createdBy) : undefined,
		state: status?.toString(),
		merged: status === PullRequestStatus.Completed,
		assignees: reviewers ? reviewers.map(reviewer => convertRESTUserToAccount(reviewer)) : undefined,
		createdAt: creationDate?.toLocaleString(),
		head: sourceRefName,
		base: targetRefName,
		mergeable: mergeStatus !== undefined ? <PullRequestMergeability> (mergeStatus as any) : undefined,
		isDraft: isDraft,
		suggestedReviewers: [] // suggested reviewers only available through GraphQL API
	};

	return item;
}

export function convertRESTUserToAccount(user: IdentityRef): IAccount {
	return {
		name: user.displayName,
		email: user.uniqueName,
		url: user.url,
		id: user.id,
		avatarUrl: user.imageUrl
	}
}

export function convertAzdoBranchRefToIGitHubRef(branch: GitBranchStats): IGitHubRef {
	return {
		ref: branch.name || '',
		sha: branch.commit?.commitId || ''
	}
}