/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { CredentialStore, GitHub } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { hasEnterpriseUri } from '../../github/utils';
import { ChatParticipantState } from '../participants';

export interface IToolCall {
	tool: vscode.LanguageModelToolInformation;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

export const TOOL_MARKDOWN_RESULT = 'TOOL_MARKDOWN_RESULT';
export const TOOL_COMMAND_RESULT = 'TOOL_COMMAND_RESULT';

export interface IssueToolParameters {
	issueNumber: number;
	repo: {
		owner: string;
		name: string;
	};
}

export interface IssueResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

export abstract class ToolBase<T> implements vscode.LanguageModelTool<T> {
	constructor(protected readonly chatParticipantState: ChatParticipantState) { }
	abstract invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelToolResult>;
}

export async function concatAsyncIterable(asyncIterable: AsyncIterable<string>): Promise<string> {
	let result = '';
	for await (const chunk of asyncIterable) {
		result += chunk;
	}
	return result;
}

export abstract class RepoToolBase<T> extends ToolBase<T> {
	constructor(private readonly credentialStore: CredentialStore, private readonly repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	protected async getRepoInfo(options: { owner?: string, name?: string }): Promise<{ owner: string; name: string; folderManager: FolderRepositoryManager }> {
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.owner && options.name && !options.owner.includes('owner') && !options.name.includes('name')) {
			owner = options.owner;
			name = options.name;
			folderManager = this.repositoriesManager.getManagerForRepository(options.owner, options.name);
		}

		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
			if (owner && name) {
				await folderManager.createGitHubRepositoryFromOwnerName(owner, name);
			} else {
				owner = folderManager.gitHubRepositories[0].remote.owner;
				name = folderManager.gitHubRepositories[0].remote.repositoryName;
			}
		}

		if (!folderManager || !owner || !name) {
			throw new Error(`No repository found for ${owner}/${name}. Make sure to have the repository open.`);
		}
		return { owner, name, folderManager };
	}

	protected getGitHub(): GitHub | undefined {
		let authProvider: AuthProvider | undefined;
		if (this.credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			authProvider = AuthProvider.githubEnterprise;
		} else if (this.credentialStore.isAuthenticated(AuthProvider.github)) {
			authProvider = AuthProvider.github;
		}
		return (authProvider !== undefined) ? this.credentialStore.getHub(authProvider) : undefined;
	}
}