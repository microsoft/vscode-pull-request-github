/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager, ReposManagerState, ReposManagerStateContext } from './folderRepositoryManager';
import { PullRequestChangeEvent } from './githubRepository';
import { IssueModel } from './issueModel';
import { findDotComAndEnterpriseRemotes } from './utils';
import { Repository } from '../api/api';
import { addEnterpriseUri, getEnterpriseUris, parseEnterpriseUri } from '../authentication/configuration';
import { AuthProvider } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { GitHubRemote, Remote } from '../common/remote';
import { GITHUB_ENTERPRISE, URI, URIS } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { EventType } from '../common/timelineEvent';
import { fromPRUri, fromRepoUri, Schemes } from '../common/uri';
import { compareIgnoreCase, formatError, isDescendant } from '../common/utils';
import { EXTENSION_ID } from '../constants';

export interface ItemsResponseResult<T> {
	items: T[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
}

export interface PullRequestDefaults {
	owner: string;
	repo: string;
	base: string;
}

export class RepositoriesManager extends Disposable {
	static ID = 'RepositoriesManager';

	private _folderManagers: FolderRepositoryManager[] = [];
	private _subs: Map<FolderRepositoryManager, vscode.Disposable[]>;

	private _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

	private _onDidChangeFolderRepositories = new vscode.EventEmitter<{ added?: FolderRepositoryManager }>();
	readonly onDidChangeFolderRepositories = this._onDidChangeFolderRepositories.event;

	private _onDidLoadAnyRepositories = new vscode.EventEmitter<void>();
	readonly onDidLoadAnyRepositories = this._onDidLoadAnyRepositories.event;

	private _onDidChangeAnyPullRequests = new vscode.EventEmitter<PullRequestChangeEvent[]>();
	readonly onDidChangeAnyPullRequests = this._onDidChangeAnyPullRequests.event;

	private _onDidAddPullRequest = new vscode.EventEmitter<IssueModel>();
	readonly onDidAddPullRequest = this._onDidAddPullRequest.event;

	private _onDidAddAnyGitHubRepository = new vscode.EventEmitter<FolderRepositoryManager>();
	readonly onDidChangeAnyGitHubRepository = this._onDidAddAnyGitHubRepository.event;

	private _state: ReposManagerState = ReposManagerState.Initializing;

	constructor(
		private _credentialStore: CredentialStore,
		private _telemetry: ITelemetry,
	) {
		super();
		this._subs = new Map();
		vscode.commands.executeCommand('setContext', ReposManagerStateContext, this._state);
		this.updateEnterpriseConfigurationContext();
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${GITHUB_ENTERPRISE}.${URIS}`) || e.affectsConfiguration(`${GITHUB_ENTERPRISE}.${URI}`)) {
				this.updateEnterpriseConfigurationContext();
			}
		}));
		this._register(vscode.workspace.onDidGrantWorkspaceTrust(() => this.updateEnterpriseConfigurationContext()));
	}

	private updateEnterpriseConfigurationContext(): void {
		let hasEnterpriseUris = false;
		try {
			hasEnterpriseUris = getEnterpriseUris().length > 0;
		} catch (error) {
			// The authentication provider reports configuration errors; keep the welcome context unavailable.
			Logger.error(`Invalid GitHub Enterprise configuration: ${formatError(error)}`, RepositoriesManager.ID);
		}
		commands.setContext(contexts.HAS_ENTERPRISE_URIS, hasEnterpriseUris);
	}

	private updateActiveReviewCount() {
		let count = 0;
		for (const folderManager of this._folderManagers) {
			if (folderManager.activePullRequest) {
				count++;
			}
		}
		commands.setContext(contexts.ACTIVE_PR_COUNT, count);
	}

	get folderManagers(): FolderRepositoryManager[] {
		return this._folderManagers;
	}

	get activeGitHubRemotes(): readonly GitHubRemote[] {
		return this._folderManagers.flatMap(manager => manager.getActiveGitHubRemotes());
	}

	private registerFolderListeners(folderManager: FolderRepositoryManager) {
		const disposables = [
			folderManager.onDidLoadRepositories(() => {
				this.updateState();
				this._onDidLoadAnyRepositories.fire();
			}),
			folderManager.onDidChangeRepositories(() => this._onDidLoadAnyRepositories.fire()),
			folderManager.onDidChangeActivePullRequest(() => this.updateActiveReviewCount()),
			folderManager.onDidDispose(() => this.removeRepo(folderManager.repository)),
			folderManager.onDidChangeAnyPullRequests(e => this._onDidChangeAnyPullRequests.fire(e)),
			folderManager.onDidAddPullRequest(e => this._onDidAddPullRequest.fire(e)),
			folderManager.onDidChangeGithubRepositories(() => this._onDidAddAnyGitHubRepository.fire(folderManager)),
			folderManager.repository.state.onDidChange(() => this.checkWorktreeChanges(folderManager.repository)),
		];
		this._subs.set(folderManager, disposables);
	}

	private _previousWorktrees: Map<string, Set<string>> = new Map();

	private checkWorktreeChanges(repo: Repository): void {
		const worktrees = repo.state.worktrees;
		if (!worktrees) {
			return;
		}

		const repoKey = repo.rootUri.toString();
		const currentPaths = new Set(worktrees.map(wt => vscode.Uri.file(wt.path).toString()));
		const previousPaths = this._previousWorktrees.get(repoKey);
		this._previousWorktrees.set(repoKey, currentPaths);

		if (!previousPaths) {
			return;
		}

		for (const previousPath of previousPaths) {
			if (!currentPaths.has(previousPath)) {
				const folderManager = this._folderManagers.find(m => m.repository.rootUri.toString() === previousPath);
				if (folderManager) {
					Logger.appendLine(`Removing folder manager for removed worktree ${previousPath}`, RepositoriesManager.ID);
					this.removeRepo(folderManager.repository);
				}
			}
		}
	}

	insertFolderManager(folderManager: FolderRepositoryManager) {
		this.registerFolderListeners(folderManager);

		// Try to insert the new repository in workspace folder order
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			const index = workspaceFolders.findIndex(
				folder => isDescendant(folder.uri.fsPath, folderManager.repository.rootUri.fsPath) || isDescendant(folderManager.repository.rootUri.fsPath, folder.uri.fsPath),
			);
			if (index > -1) {
				const arrayEnd = this._folderManagers.slice(index, this._folderManagers.length);
				this._folderManagers = this._folderManagers.slice(0, index);
				this._folderManagers.push(folderManager);
				this._folderManagers.push(...arrayEnd);
				this.updateActiveReviewCount();
				this._onDidChangeFolderRepositories.fire({ added: folderManager });
				return;
			}
		}
		this._folderManagers.push(folderManager);
		this.updateActiveReviewCount();
		this._onDidChangeFolderRepositories.fire({ added: folderManager });
	}

	removeRepo(repo: Repository) {
		const existingFolderManagerIndex = this._folderManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (existingFolderManagerIndex > -1) {
			const folderManager = this._folderManagers[existingFolderManagerIndex];
			disposeAll(this._subs.get(folderManager)!);
			this._subs.delete(folderManager);
			this._folderManagers.splice(existingFolderManagerIndex, 1);
			folderManager.dispose();
			this.updateActiveReviewCount();
			this._onDidChangeFolderRepositories.fire({});
		}
	}

	getManagerForIssueModel(issueModel: IssueModel | undefined): FolderRepositoryManager | undefined {
		if (issueModel === undefined) {
			return undefined;
		}
		return this.getManagerForRepository(issueModel.remote.owner, issueModel.remote.repositoryName);
	}

	getManagerForFile(uri: vscode.Uri): FolderRepositoryManager | undefined {
		if (uri.scheme === 'untitled') {
			return this._folderManagers[0];
		}

		const repoInfo = ((uri.scheme === Schemes.Repo) ? fromRepoUri(uri) : undefined);
		const prInfo = ((uri.scheme === Schemes.Pr) ? fromPRUri(uri) : undefined);

		// Prioritize longest path first to handle nested workspaces
		const folderManagers = this._folderManagers
			.slice()
			.sort((a, b) => b.repository.rootUri.path.length - a.repository.rootUri.path.length);

		for (const folderManager of folderManagers) {
			const managerPath = folderManager.repository.rootUri.path;

			if (repoInfo && folderManager.findExistingGitHubRepository({ owner: repoInfo.owner, repositoryName: repoInfo.repo })) {
				return folderManager;
			} else if (prInfo && folderManager.repository.state.remotes.find(remote => remote.name === prInfo.remoteName)) {
				return folderManager;
			} else {
				const testUriRelativePath = uri.path.substring(
					managerPath.length > 1 ? managerPath.length + 1 : managerPath.length,
				);
				if (compareIgnoreCase(vscode.Uri.joinPath(folderManager.repository.rootUri, testUriRelativePath).path, uri.path) === 0) {
					return folderManager;
				}
			}
		}
		return undefined;
	}

	getManagerForRepository(owner: string, repo: string) {
		const issueRemoteUrl = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
		for (const folderManager of this._folderManagers) {
			if (
				folderManager.gitHubRepositories
					.map(repo =>
						`${repo.remote.owner.toLowerCase()}/${repo.remote.repositoryName.toLowerCase()}`
					)
					.includes(issueRemoteUrl)
			) {
				return folderManager;
			}
		}
	}

	get state() {
		return this._state;
	}

	private updateState(state?: ReposManagerState) {
		let maxState = ReposManagerState.Initializing;
		if (state) {
			maxState = state;
		} else {
			// Get the most advanced state from all folder managers
			const stateValue = (testState: ReposManagerState) => {
				switch (testState) {
					case ReposManagerState.Initializing: return 0;
					case ReposManagerState.NeedsAuthentication: return 1;
					case ReposManagerState.RepositoriesLoaded: return 2;
				}
			};
			for (const folderManager of this._folderManagers) {
				if (stateValue(folderManager.state) > stateValue(maxState)) {
					maxState = folderManager.state;
				}
			}
		}
		const stateChange = maxState !== this._state;
		this._state = maxState;
		if (stateChange) {
			vscode.commands.executeCommand('setContext', ReposManagerStateContext, maxState);
			this._onDidChangeState.fire();
		}
	}

	get credentialStore(): CredentialStore {
		return this._credentialStore;
	}

	clearForAuthChange(): void {
		for (const folderManager of this._folderManagers) {
			folderManager.clearForAuthChange();
		}
	}

	async refreshRepositories(): Promise<void> {
		await Promise.all(this._folderManagers.map(folderManager => folderManager.updateRepositories(false, true)));
		this.updateState();
	}

	async selectEnterpriseAccount(): Promise<void> {
		try {
			const accounts = await vscode.authentication.getAccounts(AuthProvider.githubEnterprise);
			if (accounts.length) {
				await commands.executeCommand(commands.MANAGE_EXTENSION_ACCOUNT_PREFERENCES, EXTENSION_ID, AuthProvider.githubEnterprise);
			} else {
				await this.authenticate(true);
			}
		} catch (error) {
			Logger.error(`Selecting a GitHub Enterprise account failed: ${formatError(error)}`, RepositoriesManager.ID);
			void vscode.window.showErrorMessage(vscode.l10n.t('Unable to select a GitHub Enterprise account: {0}', formatError(error)));
		}
	}

	async authenticate(enterprise?: boolean): Promise<boolean> {
		if (enterprise === false) {
			return !!(await this._credentialStore.login(AuthProvider.github));
		}
		const { dotComRemotes, enterpriseRemotes, unknownRemotes } = await findDotComAndEnterpriseRemotes(this.folderManagers);
		try {
			if (!getEnterpriseUris().length) {
				if (enterprise === undefined && dotComRemotes.length === 0 && enterpriseRemotes.length > 0) {
					const yes = vscode.l10n.t('Yes');
					const result = await vscode.window.showInformationMessage(
						vscode.l10n.t('It looks like you might be using GitHub Enterprise. Would you like to set up GitHub Enterprise authentication?'),
						{ modal: true }, yes, vscode.l10n.t('No, use GitHub.com'));
					if (result === undefined) {
						return false;
					}
					enterprise = result === yes;
				}
				if (enterprise && !(await configureEnterprise([...enterpriseRemotes, ...unknownRemotes]))) {
					return false;
				}
			}
		} catch (error) {
			Logger.error(`GitHub Enterprise setup failed: ${formatError(error)}`, RepositoriesManager.ID);
			const settings = vscode.l10n.t('Open Settings');
			if (await vscode.window.showErrorMessage(formatError(error), settings) === settings) {
				await commands.executeCommand('workbench.action.openSettings', `${GITHUB_ENTERPRISE}.${URIS}`);
			}
			return false;
		}

		let githubEnterprise;
		const hasNonDotComRemote = (enterpriseRemotes.length > 0) || (unknownRemotes.length > 0);
		const preferEnterprise = enterprise ?? (hasNonDotComRemote && (dotComRemotes.length === 0 || this._credentialStore.isAuthenticated(AuthProvider.githubEnterprise)));
		if (preferEnterprise) {
			const previous = this._credentialStore.getHub(AuthProvider.githubEnterprise);
			githubEnterprise = await this._credentialStore.login(AuthProvider.githubEnterprise);
			if (enterprise === true && previous && previous === githubEnterprise) {
				const selectAccount = vscode.l10n.t('Select Account');
				const result = await vscode.window.showInformationMessage(vscode.l10n.t('Already signed in to GitHub Enterprise.'), selectAccount);
				if (result === selectAccount) {
					await this.selectEnterpriseAccount();
				}
			}
		}
		let github;
		if (!githubEnterprise && (!preferEnterprise || (enterprise !== true && enterpriseRemotes.length === 0))) {
			github = await this._credentialStore.login(AuthProvider.github);
		}
		return !!github || !!githubEnterprise;
	}

	override dispose() {
		this._subs.forEach(sub => disposeAll(sub));
		super.dispose();
	}
}

async function configureEnterprise(remotes: Remote[]): Promise<boolean> {
	const candidates = [...new Set(remotes.map(remote => remote.normalizedHost))];
	let host: string | undefined;
	if (candidates.length === 1) {
		const yes = vscode.l10n.t('Yes');
		const manual = vscode.l10n.t('Enter a different instance URL');
		const result = await vscode.window.showInformationMessage(
			vscode.l10n.t('Would you like to add {0} to {1}?', candidates[0], `${GITHUB_ENTERPRISE}.${URIS}`),
			{ modal: true }, yes, manual);
		if (result === undefined) {
			return false;
		}
		host = result === yes ? candidates[0] : undefined;
	} else if (candidates.length > 1) {
		const selected = await vscode.window.showQuickPick([
			...candidates.map(host => ({ label: host, host })),
			{ label: vscode.l10n.t('Enter an instance URL...'), host: undefined },
		], { placeHolder: vscode.l10n.t('Select the GitHub Enterprise instance to configure'), ignoreFocusOut: true });
		if (!selected) {
			return false;
		}
		host = selected.host;
	}
	if (!host) {
		host = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Add a GitHub Enterprise instance to {0}', `${GITHUB_ENTERPRISE}.${URIS}`),
			placeHolder: vscode.l10n.t('GitHub Enterprise instance URL'),
			ignoreFocusOut: true,
			validateInput: value => {
				try {
					parseEnterpriseUri(value);
					return undefined;
				} catch (error) {
					return formatError(error);
				}
			},
		});
	}
	if (!host) {
		return false;
	}
	await addEnterpriseUri(host);
	return true;
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}
