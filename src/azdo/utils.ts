import { IdentityRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { FileDiff, GitBranchStats, GitPullRequest, LineDiffBlockChangeType, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
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

export function getDiffHunkFromFileDiff(fileDiff: FileDiff): DiffHunk[] {
	const diff: DiffHunk[] = [];
	let positionInHunk = 0;

	const validBlocks = fileDiff.lineDiffBlocks?.filter(d => d.changeType !== LineDiffBlockChangeType.None) ?? [];

	for (const block of validBlocks) {
		const hunk = new DiffHunk(block.originalLineNumberStart!, block.originalLinesCount!, block.modifiedLineNumberStart!, block.modifiedLinesCount!, positionInHunk);

		const oldLineNumber = block.originalLineNumberStart!;
		const newLineNumber = block.modifiedLineNumberStart!;

		if (block.changeType === LineDiffBlockChangeType.Add) {
			for (let i = 0; i<block.modifiedLinesCount!; i++) {
				hunk.diffLines.push(new DiffLine(DiffChangeType.Add, -1, newLineNumber+i, positionInHunk));
				positionInHunk++;
			}
		} else if (block.changeType === LineDiffBlockChangeType.Delete) {
			for (let i = 0; i<block.originalLinesCount!; i++) {
				hunk.diffLines.push(new DiffLine(DiffChangeType.Delete, oldLineNumber+i, -1, positionInHunk));
				positionInHunk++;
			}
		} else if (block.changeType === LineDiffBlockChangeType.Edit) {
			for (let i = 0; i < Math.max(block.originalLinesCount!, block.modifiedLinesCount!); i++) {
				let type = DiffChangeType.Context;
				let o = oldLineNumber + i;
				let m = newLineNumber + i;
				if (o >= block.originalLinesCount!) {
					type = DiffChangeType.Add;
					o = -1;
				}
				if (m >= block.modifiedLinesCount!) {
					type = DiffChangeType.Delete;
					m = -1;
				}
				hunk.diffLines.push(new DiffLine(type, o, m, positionInHunk));
				positionInHunk++;
			}
		}
		diff.push(hunk);
	}

	return diff;
}