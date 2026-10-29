/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthenticationError, AuthProvider } from '../../common/authentication';
import { CredentialStore, GitHub } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { hasEnterpriseUri } from '../../github/utils';

export interface IToolCall {
	tool: vscode.LanguageModelToolInformation;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

export const TOOL_MARKDOWN_RESULT = 'TOOL_MARKDOWN_RESULT';
export const TOOL_COMMAND_RESULT = 'TOOL_COMMAND_RESULT';

export interface IssueToolParameters {
	issueNumber?: number;
	repo?: {
		owner?: string;
		name?: string;
	};
}

export interface IssueResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

interface RepoInfo {
	owner: string;
	name: string;
	folderManager: FolderRepositoryManager;
}

export abstract class ToolBase<T> implements vscode.LanguageModelTool<T> {
	constructor() { }
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
	constructor(private readonly credentialStore: CredentialStore, private readonly repositoriesManager: RepositoriesManager) {
		super();
	}

	/**
	 * Resolves the repository to use, falling back to the workspace's default repository
	 * when the owner and name are missing or look like LLM placeholders.
	 */
	protected async getRepoInfo(options: { owner?: string, name?: string }): Promise<RepoInfo> {
		this.ensureAuthenticated();

		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.owner && options.name && !options.owner.includes('owner') && !options.name.includes('name')) {
			return this.resolveRepoInfo(options.owner, options.name);
		}

		const folderManager = this.repositoriesManager.folderManagers[0];
		if (!folderManager) {
			throw new Error('No repository found. Make sure to have the repository open.');
		}
		const defaults = await folderManager.getPullRequestDefaults();
		if (defaults) {
			return { owner: defaults.owner, name: defaults.repo, folderManager };
		}
		const remote = folderManager.gitHubRepositories[0].remote;
		return { owner: remote.owner, name: remote.repositoryName, folderManager };
	}

	/**
	 * Resolves exactly the given repository, without falling back to the workspace's default repository.
	 */
	protected async getExactRepoInfo(options: { owner?: string, name?: string }): Promise<RepoInfo> {
		this.ensureAuthenticated();
		if (!options.owner || !options.name) {
			throw new Error('Repository owner and name are required.');
		}
		return this.resolveRepoInfo(options.owner, options.name);
	}

	private ensureAuthenticated(): void {
		if (!this.credentialStore.isAnyAuthenticated()) {
			throw new AuthenticationError();
		}
	}

	private async resolveRepoInfo(owner: string, name: string): Promise<RepoInfo> {
		let folderManager = this.repositoriesManager.getManagerForRepository(owner, name);
		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
			await folderManager.createGitHubRepositoryFromOwnerName(owner, name);
		}
		if (!folderManager) {
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