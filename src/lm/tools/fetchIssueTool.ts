/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepoToolBase } from './toolsUtils';

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
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchIssueToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { owner, name, folderManager } = this.getRepoInfo({ owner: options.parameters.repo?.owner, name: options.parameters.repo?.name });
		const issueOrPullRequest = await folderManager.resolveIssueOrPullRequest(owner, name, options.parameters.issueNumber);
		if (!issueOrPullRequest) {
			throw new Error(`No issue or PR found for ${owner}/${name}/${options.parameters.issueNumber}. Make sure the issue or PR exists.`);
		}
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
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result)),
		new vscode.LanguageModelTextPart('Above is a stringified JSON representation of the issue or pull request. This can be passed to other tools for further processing.')
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchIssueToolParameters>): Promise<vscode.PreparedToolInvocation> {
		if (!options.parameters.issueNumber) {
			return {
				invocationMessage: vscode.l10n.t('Fetching item from GitHub')
			};
		}
		const { owner, name } = this.getRepoInfo({ owner: options.parameters.repo?.owner, name: options.parameters.repo?.name });
		const url = (owner && name) ? `https://github.com/${owner}/${name}/issues/${options.parameters.issueNumber}` : undefined;
		return {
			invocationMessage: url ? vscode.l10n.t('Fetching item [#{0}]({1}) from GitHub', options.parameters.issueNumber, url) : vscode.l10n.t('Fetching item #{0} from GitHub', options.parameters.issueNumber),
		};
	}
}