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
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

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

export const enum MimeTypes {
	textPlain = 'text/plain',
	textMarkdown = 'text/markdown',
	textJson = 'text/json',
	textDisplay = 'text/display' // our own made up mime type for stuff that should be shown in chat to the user
}

interface RepoToolBaseParameters {
	repo?: {
		owner?: string;
		name?: string;
	};
}

export abstract class RepoToolBase<T extends RepoToolBaseParameters> extends ToolBase<T> {
	constructor(private readonly credentialStore: CredentialStore, private readonly repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	protected getRepoInfo(options: { parameters: T }): { owner: string; name: string; folderManager: FolderRepositoryManager } {
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.parameters.repo && options.parameters.repo.owner && options.parameters.repo.name && !options.parameters.repo.owner.includes('owner') && !options.parameters.repo.name.includes('name')) {
			owner = options.parameters.repo.owner;
			name = options.parameters.repo.name;
			folderManager = this.repositoriesManager.getManagerForRepository(options.parameters.repo.owner, options.parameters.repo.name);
		} else if (this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
			owner = folderManager.gitHubRepositories[0].remote.owner;
			name = folderManager.gitHubRepositories[0].remote.repositoryName;
		}
		if (!folderManager || !owner || !name) {
			throw new Error(`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`);
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