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

interface FetchToolParameters {
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

export interface FetchResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
	fileChanges?: FileChange[];
}

export class FetchTool extends RepoToolBase<FetchToolParameters> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { owner, name, folderManager } = this.getRepoInfo(options);
		const issueOrPullRequest = await this._fetchIssueOrPR(options, folderManager, owner, name);
		const result: FetchResult = {
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

	async prepareToolInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchToolParameters>): Promise<vscode.PreparedToolInvocation> {
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

	private async _fetchIssueOrPR(options: vscode.LanguageModelToolInvocationOptions<FetchToolParameters>, folderManager: FolderRepositoryManager, owner: string, name: string): Promise<PullRequestModel | IssueModel> {
		let issueOrPullRequest: IssueModel | PullRequestModel | undefined = await folderManager.resolveIssue(owner, name, options.parameters.issueNumber, true);
		if (!issueOrPullRequest) {
			issueOrPullRequest = await folderManager.resolvePullRequest(owner, name, options.parameters.issueNumber);
		}
		if (!issueOrPullRequest) {
			throw new Error(`No issue or PR found for ${owner}/${name}/${options.parameters.issueNumber}. Make sure the issue or PR exists.`);
		}
		return issueOrPullRequest;
	}
}