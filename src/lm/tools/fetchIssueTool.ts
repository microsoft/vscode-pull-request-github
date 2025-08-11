/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { isITeam } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepoToolBase } from './toolsUtils';

interface FetchIssueToolParameters {
	issueNumber?: number;
	repo?: {
		owner?: string;
		name?: string;
	};
}

interface FileChange {
	fileName?: string;
	patch?: string;
}

export interface FetchIssueResult {
	title?: string;
	body?: string;
	comments?: {
		author?: string;
		body?: string;
	}[];
	owner?: string;
	repo?: string;
	fileChanges?: FileChange[];
	author?: string;
	assignees?: string[];
	reviewers?: string[];
}

export class FetchIssueTool extends RepoToolBase<FetchIssueToolParameters> {
	public static readonly toolId = 'github-pull-request_issue_fetch';

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchIssueToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const issueNumber = options.input.issueNumber;
		if (!issueNumber) {
			throw new Error('No issue/PR number provided.');
		}
		const { owner, name, folderManager } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const issueOrPullRequest = await folderManager.resolveIssueOrPullRequest(owner, name, issueNumber);
		if (!issueOrPullRequest) {
			throw new Error(`No issue or PR found for ${owner}/${name}/${issueNumber}. Make sure the issue or PR exists.`);
		}
		const result: FetchIssueResult = {
			owner,
			repo: name,
			title: issueOrPullRequest.title,
			body: issueOrPullRequest.body,
			comments: issueOrPullRequest.item.comments?.map(c => ({ body: c.body, author: c.author.login })) ?? [],
			author: issueOrPullRequest.author?.login,
			assignees: issueOrPullRequest.assignees?.map(a => a.login),
			reviewers: issueOrPullRequest instanceof PullRequestModel ? issueOrPullRequest.reviewers?.map(r => isITeam(r) ? r.name : r.login).filter((login): login is string => !!login) : undefined
		};
		if (issueOrPullRequest instanceof PullRequestModel && issueOrPullRequest.isResolved()) {
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
		if (!options.input.issueNumber) {
			return {
				invocationMessage: vscode.l10n.t('Fetching item from GitHub')
			};
		}
		const { owner, name } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const url = (owner && name) ? `https://github.com/${owner}/${name}/issues/${options.input.issueNumber}` : undefined;
		const message = url ? new vscode.MarkdownString(vscode.l10n.t('Fetching item [#{0}]({1}) from GitHub', options.input.issueNumber, url)) : vscode.l10n.t('Fetching item #{0} from GitHub', options.input.issueNumber);
		return {
			invocationMessage: message,
		};
	}
}