/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IssueModel } from '../../github/issueModel';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MimeTypes, RepoToolBase } from './toolsUtils';

interface FetchIssueToolParameters {
	issueNumber: number;
	repo?: {
		owner: string;
		name: string;
	};
}

interface FileChange {
	fileName: string;
	patch: string;
}

export interface FetchIssueResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
	fileChanges?: FileChange[];
}

export class FetchIssueTool extends RepoToolBase<FetchIssueToolParameters> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchIssueToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { owner, name, folderManager } = this.getRepoInfo(options);
		const issueOrPullRequest = await fetchIssueOrPR(options.parameters.issueNumber, folderManager, owner, name);
		const result: FetchIssueResult = {
			title: issueOrPullRequest.title,
			body: issueOrPullRequest.body,
			comments: issueOrPullRequest.item.comments?.map(c => ({ body: c.body })) ?? []
		};
		if (issueOrPullRequest instanceof PullRequestModel) {
			const fileChanges = await issueOrPullRequest.getFileChangesInfo();
			const fetchedFileChanges: FileChange[] = [];
			for (const fileChange of fileChanges) {
				if (fileChange instanceof InMemFileChange) {
					fetchedFileChanges.push({
						fileName: fileChange.fileName,
						patch: fileChange.patch
					});
				}
			}
			result.fileChanges = fetchedFileChanges;
		}
		return {
			[MimeTypes.textPlain]: JSON.stringify(result),
			[MimeTypes.textJson]: result
		};
	}

	async prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchIssueToolParameters>): Promise<vscode.PreparedToolInvocation> {
		if (!options.parameters.issueNumber) {
			return {
				invocationMessage: vscode.l10n.t('Fetching item from GitHub')
			};
		}
		const { owner, name } = this.getRepoInfo(options);
		const url = (owner && name) ? `https://github.com/${owner}/${name}/issues/${options.parameters.issueNumber}` : undefined;
		return {
			invocationMessage: url ? vscode.l10n.t('Fetching item [#{0}]({1}) from GitHub', options.parameters.issueNumber, url) : vscode.l10n.t('Fetching item #{0} from GitHub', options.parameters.issueNumber),
		};
	}
}

// place into the folder manager instead
export async function fetchIssueOrPR(issueNumber: number, folderManager: FolderRepositoryManager, owner: string, name: string): Promise<PullRequestModel | IssueModel> {
	let issueOrPullRequest: IssueModel | PullRequestModel | undefined = await folderManager.resolveIssue(owner, name, issueNumber, true);
	if (!issueOrPullRequest) {
		issueOrPullRequest = await folderManager.resolvePullRequest(owner, name, issueNumber);
	}
	if (!issueOrPullRequest) {
		throw new Error(`No issue or PR found for ${owner}/${name}/${issueNumber}. Make sure the issue or PR exists.`);
	}
	return issueOrPullRequest;
}