import { IdentityRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { CommentType, FileDiff, GitBranchStats, GitCommitRef, GitPullRequest, GitPullRequestCommentThread, LineDiffBlockChangeType, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import { DiffChangeType, DiffHunk, DiffLine } from '../common/diffHunk';
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

export function convertRESTIdentityToAccount(user: Identity): IAccount {
	return {
		name: user.providerDisplayName,
		email: user.properties['Account']['$value'],
		url: '',
		id: user.id,
		avatarUrl: ''
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

export async function readableToString(readable?: NodeJS.ReadableStream): Promise<string | undefined> {
	if (!readable) {
		return undefined;
	}
	let result = '';
	for await (const chunk of readable) {
		result += chunk;
	}
	return result;
}

/**
 * Used for case insensitive sort by login
 */
export function loginComparator(a: IAccount, b: IAccount) {
	// sensitivity: 'accent' allows case insensitive comparison
	return a.id?.localeCompare(b.id || '', 'en', { sensitivity: 'accent' }) || -1;
}

export function getDiffHunkFromFileDiff(fileDiff: FileDiff): DiffHunk[] {
	const diff: DiffHunk[] = [];
	let positionInHunk = 0;

	const validBlocks = fileDiff.lineDiffBlocks?.filter(d => d.changeType !== LineDiffBlockChangeType.None) ?? [];

	for (const block of validBlocks) {
		const hunk = new DiffHunk(block.originalLineNumberStart!, block.originalLinesCount!, block.modifiedLineNumberStart!, block.modifiedLinesCount!, positionInHunk);

		const oldLineNumber = block.originalLineNumberStart!;
		const newLineNumber = block.modifiedLineNumberStart!;

		for (let i = 0; i < Math.max(block.originalLinesCount!, block.modifiedLinesCount!); i++) {
			let type = DiffChangeType.Context;
			let o = oldLineNumber + i;
			let m = newLineNumber + i;
			if (i >= block.originalLinesCount! || block.changeType === LineDiffBlockChangeType.Add) {
				type = DiffChangeType.Add;
				o = -1;
			}
			if (i >= block.modifiedLinesCount! || block.changeType === LineDiffBlockChangeType.Delete) {
				type = DiffChangeType.Delete;
				m = -1;
			}
			hunk.diffLines.push(new DiffLine(type, o, m, positionInHunk));
			positionInHunk++;
		}

		// if (block.changeType === LineDiffBlockChangeType.Add) {
		// 	for (let i = 0; i<block.modifiedLinesCount!; i++) {
		// 		hunk.diffLines.push(new DiffLine(DiffChangeType.Add, -1, newLineNumber+i, positionInHunk));
		// 		positionInHunk++;
		// 	}
		// } else if (block.changeType === LineDiffBlockChangeType.Delete) {
		// 	for (let i = 0; i<block.originalLinesCount!; i++) {
		// 		hunk.diffLines.push(new DiffLine(DiffChangeType.Delete, oldLineNumber+i, -1, positionInHunk));
		// 		positionInHunk++;
		// 	}
		// } else if (block.changeType === LineDiffBlockChangeType.Edit) {
		// 	for (let i = 0; i < Math.max(block.originalLinesCount!, block.modifiedLinesCount!); i++) {
		// 		let type = DiffChangeType.Context;
		// 		let o = oldLineNumber + i;
		// 		let m = newLineNumber + i;
		// 		if (o >= block.originalLinesCount!) {
		// 			type = DiffChangeType.Add;
		// 			o = -1;
		// 		}
		// 		if (m >= block.modifiedLinesCount!) {
		// 			type = DiffChangeType.Delete;
		// 			m = -1;
		// 		}
		// 		hunk.diffLines.push(new DiffLine(type, o, m, positionInHunk));
		// 		positionInHunk++;
		// 	}
		// }
		diff.push(hunk);
	}

	return diff;
}

export function isUserThread(thread: GitPullRequestCommentThread): boolean {
	return thread.comments?.find(c => c.id === 1)?.commentType === CommentType.Text ?? true;
}

export function isSystemThread(thread: GitPullRequestCommentThread): boolean {
	return thread.comments?.find(c => c.id === 1)?.commentType !== CommentType.Text ?? false;
}

export function getRelatedUsersFromPullrequest(pr: PullRequest, threads?: GitPullRequestCommentThread[], commits?: GitCommitRef[]): { login: string; name?: string; email?: string}[] {
	if (!commits || commits.length === 0) {
		commits = pr.commits;
	}

	const related_users: { login: string; name?: string; email?: string}[] = [];

	related_users.push(
		{
			login: pr.createdBy?.uniqueName ?? pr.createdBy?.id ?? '',
			email: pr.createdBy?.uniqueName,
			name: pr.createdBy?.displayName
		}
	);

	related_users.push(
		...(pr.reviewers ?? []).map(r => {return { name: r.displayName, login: r.uniqueName ?? r.id ?? '', email: r.uniqueName};}),
		...([] as IdentityRef[]).concat(...threads?.map(t => t.comments?.map(c => c.author!) || []) || []).map(r => {return { name: r.displayName, login: r.uniqueName ?? r.id ?? '', email: r.uniqueName};}),
		...commits?.map(c => c.author ?? c.committer).filter(c => !!c).map(r => {return { name: r?.name, login: r?.email || '', email: r?.email};}) || []);

	return related_users;

}