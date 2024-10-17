/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { MimeTypes, RepoToolBase } from './toolsUtils';
import { fetchIssueOrPR } from './fetchIssueTool';
import { PullRequestModel } from '../../github/pullRequestModel';
import { InMemFileChange } from '../../common/file';

interface FetchNotificationToolParameters {
	thread_id: number;
	repo?: {
		owner: string;
		name: string;
	};
}

interface FileChange {
	fileName: string;
	patch: string;
}

export interface FetchNotificationResult {
	lastReadAt?: string;
	lastUpdatedAt: string;
	unread: boolean;
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
	fileChanges?: FileChange[];
}

export class FetchNotificationTool extends RepoToolBase<FetchNotificationToolParameters> {

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchNotificationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		console.log('options : ', options);

		const github = this.getGitHub();
		if (!github) {
			return undefined;
		}
		const thread = await github.octokit.api.activity.getThread({
			thread_id: options.parameters.thread_id
		});
		console.log('thread : ', thread);
		const lastUpdatedAt = thread.data.updated_at;
		const lastReadAt = thread.data.last_read_at ?? undefined;
		const unread = thread.data.unread;
		const owner = thread.data.repository.owner.login;
		const name = thread.data.repository.name;

		const modifiedOptions = {
			parameters: {
				thread_id: options.parameters.thread_id,
				repo: {
					owner,
					name
				}
			}
		};
		const repoInfo = this.getRepoInfo(modifiedOptions);

		console.log('thread.data : ', thread.data);
		const issueNumber = thread.data.subject.url.split('/').pop();

		if (issueNumber === undefined) {
			return undefined;
		}

		const issueOrPR = await fetchIssueOrPR(Number(issueNumber), repoInfo.folderManager, owner, name);
		const result: FetchNotificationResult = {
			lastReadAt,
			lastUpdatedAt,
			unread,
			title: issueOrPR.title,
			body: issueOrPR.body,
			comments: issueOrPR.item.comments?.map(c => ({ body: c.body })) ?? []
		};
		if (issueOrPR instanceof PullRequestModel) {
			const fileChanges = await issueOrPR.getFileChangesInfo();
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
}