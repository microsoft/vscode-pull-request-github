import { IdentityRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { GitBranchStats, GitPullRequest, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzdoRepository } from './azdoRepository';
import { IAccount, PullRequest, IGitHubRef } from './interface';

export async function convertAzdoPullRequestToRawPullRequest(pullRequest: GitPullRequest, azdoRepo: AzdoRepository): Promise<PullRequest> {
	const {
		status,
		sourceRefName,
		targetRefName,
	} = pullRequest;

	const item: PullRequest = {
		merged: status === PullRequestStatus.Completed,
		head: await azdoRepo.getBranchRef(convertBranchRefToBranchName(sourceRefName || '')),
		base: await azdoRepo.getBranchRef(convertBranchRefToBranchName(targetRefName || '')),
		...pullRequest,
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
	};
}

export function convertAzdoBranchRefToIGitHubRef(branch: GitBranchStats, repocloneUrl: string): IGitHubRef {
	return {
		ref: branch.name || '',
		sha: branch.commit?.commitId || '',
		repo: { cloneUrl: repocloneUrl },
		exists: true
	};
}

export function convertBranchRefToBranchName(branchRef: string): string {
	return branchRef.split('/').reverse()[0];
}