/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepoToolBase } from './toolsUtils';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { RepositoriesManager } from '../../github/repositoriesManager';

interface CreatePullRequestToolParameters {
	title: string;
	body?: string;
	head: string;
	headOwner?: string;
	base?: string;
	draft?: boolean;
	repo?: {
		owner?: string;
		name?: string;
	};
}

interface ResolvedPullRequestParams {
	owner: string;
	name: string;
	head: string;
	base: string;
	folderManager: FolderRepositoryManager;
}

export class CreatePullRequestTool extends RepoToolBase<CreatePullRequestToolParameters> {
	public static readonly toolId = 'github-pull-request_create_pull_request';

	constructor(credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
		super(credentialStore, repositoriesManager);
	}

	private async resolveParams(input: CreatePullRequestToolParameters): Promise<ResolvedPullRequestParams> {
		const { owner, name, folderManager } = await this.getRepoInfo({ owner: input.repo?.owner, name: input.repo?.name });
		const defaults = await folderManager.getPullRequestDefaults();
		const headOwner = input.headOwner ?? defaults.owner;
		const head = `${headOwner}:${input.head}`;
		const base = input.base ?? defaults.base;
		return { owner, name, head, base, folderManager };
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<CreatePullRequestToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { owner, name, head, base, folderManager } = await this.resolveParams(options.input);

		const result = await folderManager.createPullRequest({
			owner,
			repo: name,
			title: options.input.title,
			body: options.input.body,
			head,
			base,
			draft: options.input.draft,
		});

		if (!result) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Failed to create the pull request.')]);
		}

		const prInfo = {
			number: result.number,
			title: result.title,
			body: result.body,
			url: result.html_url,
			isDraft: result.isDraft,
			state: result.state,
			base: result.base?.ref,
			head: result.head?.ref,
		};

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(prInfo))]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CreatePullRequestToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const resolved = await this.resolveParams(options.input);
		const { owner, name, base } = resolved;
		// resolved.head is "owner:branch"; extract just the branch part for display
		const headBranch = resolved.head.slice(resolved.head.indexOf(':') + 1);

		const repoLabel = `${owner}/${name}`;
		const message = new vscode.MarkdownString();
		message.appendMarkdown(`**Title:** ${options.input.title}\n\n`);
		if (options.input.body) {
			message.appendMarkdown(`**Description:** ${options.input.body}\n\n`);
		}
		message.appendMarkdown(`**Branch:** \`${headBranch}\` → \`${base}\`\n\n`);
		message.appendMarkdown(`**Repository:** ${repoLabel}\n\n`);

		return {
			invocationMessage: vscode.l10n.t('Creating pull request'),
			confirmationMessages: {
				title: vscode.l10n.t('Create Pull Request'),
				message,
			},
		};
	}
}
