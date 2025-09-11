/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FetchIssueResult } from './fetchIssueTool';
import { concatAsyncIterable } from './toolsUtils';

export class IssueSummarizationTool implements vscode.LanguageModelTool<FetchIssueResult> {
	public static readonly toolId = 'github-pull-request_issue_summarize';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchIssueResult>): Promise<vscode.PreparedToolInvocation> {
		if (!options.input.title) {
			return {
				invocationMessage: vscode.l10n.t('Summarizing issue')
			};
		}
		const shortenedTitle = options.input.title.length > 40;
		const maxLengthTitle = shortenedTitle ? options.input.title.substring(0, 40) : options.input.title;
		return {
			invocationMessage: vscode.l10n.t('Summarizing "{0}', maxLengthTitle)
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchIssueResult>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let issueOrPullRequestInfo: string = `
Title : ${options.input.title}
Body : ${options.input.body}
`;
		const fileChanges = options.input.fileChanges;
		if (fileChanges) {
			issueOrPullRequestInfo += `
The following are the files changed:
`;
			for (const fileChange of fileChanges.values()) {
				issueOrPullRequestInfo += `
File : ${fileChange.fileName}
Patch: ${fileChange.patch}
`;
			}
		}
		const comments = options.input.comments;
		if (comments) {
			for (const [index, comment] of comments.entries()) {
				issueOrPullRequestInfo += `
Comment ${index} :
Author: ${comment.author}
Body: ${comment.body}
`;
			}
		}
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const repo = options.input.repo;
		const owner = options.input.owner;

		if (model && repo && owner) {
			const messages = [vscode.LanguageModelChatMessage.User(this.summarizeInstructions(repo, owner))];
			messages.push(vscode.LanguageModelChatMessage.User(`The issue or pull request information is as follows:`));
			messages.push(vscode.LanguageModelChatMessage.User(issueOrPullRequestInfo));
			const response = await model.sendRequest(messages, {});
			const responseText = await concatAsyncIterable(response.text);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(responseText)]);
		} else {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(issueOrPullRequestInfo)]);
		}
	}

	private _summarizeInstructions(repo: string, owner: string): string {
		return `
You are an AI assistant who is very proficient in summarizing issues and pull requests (PRs).
You will be given information relative to an issue or PR : the title, the body and the comments. In the case of a PR you will also be given patches of the PR changes.
Your task is to output a summary of all this information.
Do not output code. When you try to summarize PR changes, summarize in a textual format.
Output references to other issues and PRs as Markdown links. The current issue has owner ${owner} and is in the repo ${repo}.
If a comment references for example issue or PR #123, then output either of the following in the summary depending on if it is an issue or a PR:

[#123](https://github.com/${owner}/${repo}/issues/123)
[#123](https://github.com/${owner}/${repo}/pull/123)

When you summarize comments, always give a summary of each comment and always mention the author clearly before the comment. If the author is called 'joe' and the comment is 'this is a comment', then the output should be:

joe: this is a comment

Make sure the summary is at least as short or shorter than the issue or PR with the comments and the patches if there are.
`;
	}

}