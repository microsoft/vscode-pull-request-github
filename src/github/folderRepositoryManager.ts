/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bulkhead } from 'cockatiel';
import * as vscode from 'vscode';
import type { Branch, Repository, UpstreamRef } from '../api/api';
import { GitApiImpl, GitErrorCodes } from '../api/api1';
import { GitHubManager } from '../authentication/githubServer';
import { AuthProvider, GitHubServerType } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import Logger from '../common/logger';
import { Protocol, ProtocolType } from '../common/protocol';
import { GitHubRemote, parseRepositoryRemotes, Remote } from '../common/remote';
import {
	AUTO_STASH,
	DEFAULT_MERGE_METHOD,
	GIT,
	PR_SETTINGS_NAMESPACE,
	PULL_BEFORE_CHECKOUT,
	PULL_BRANCH,
	REMOTES,
	UPSTREAM_REMOTE,
} from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { EventType } from '../common/timelineEvent';
import { Schemes } from '../common/uri';
import { formatError, Predicate } from '../common/utils';
import { PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { NEVER_SHOW_PULL_NOTIFICATION, REPO_KEYS, ReposState } from '../extensionState';
import { git } from '../gitProviders/gitCommands';
import { OctokitCommon } from './common';
import { CredentialStore } from './credentials';
import { GitHubRepository, ItemsData, PullRequestData, TeamReviewerRefreshKind, ViewerPermission } from './githubRepository';
import { PullRequestState, UserResponse } from './graphql';
import { IAccount, ILabel, IMilestone, IPullRequestsPagingOptions, Issue, ITeam, PRType, RepoAccessAndMergeMethods, User } from './interface';
import { IssueModel } from './issueModel';
import { MilestoneModel } from './milestoneModel';
import { PullRequestGitHelper, PullRequestMetadata } from './pullRequestGitHelper';
import { IResolvedPullRequestModel, PullRequestModel } from './pullRequestModel';
import {
	convertRESTIssueToRawPullRequest,
	convertRESTPullRequestToRawPullRequest,
	getOverrideBranch,
	loginComparator,
	parseGraphQLUser,
	teamComparator,
	variableSubstitution,
} from './utils';

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean | null;
}

export interface ItemsResponseResult<T> {
	items: T[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
}

export class NoGitHubReposError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return vscode.l10n.t('{0} has no GitHub remotes', this.repository.rootUri.toString());
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return vscode.l10n.t('{0} has a detached HEAD (create a branch first', this.repository.rootUri.toString());
	}
}

export class BadUpstreamError extends Error {
	constructor(public branchName: string, public upstreamRef: UpstreamRef, public problem: string) {
		super();
	}

	get message() {
		const {
			upstreamRef: { remote, name },
			branchName,
			problem,
		} = this;
		return vscode.l10n.t('The upstream ref {0} for branch {1} {2}.', `${remote}/${name}`, branchName, problem);
	}
}

export const ReposManagerStateContext: string = 'ReposManagerStateContext';

export enum ReposManagerState {
	Initializing = 'Initializing',
	NeedsAuthentication = 'NeedsAuthentication',
	RepositoriesLoaded = 'RepositoriesLoaded',
}

export interface PullRequestDefaults {
	owner: string;
	repo: string;
	base: string;
}

export const NO_MILESTONE: string = 'No Milestone';

enum PagedDataType {
	PullRequest,
	Milestones,
	IssuesWithoutMilestone,
	IssueSearch,
}

export class FolderRepositoryManager implements vscode.Disposable {
	static ID = 'FolderRepositoryManager';

	private _subs: vscode.Disposable[];
	private _activePullRequest?: PullRequestModel;
	private _activeIssue?: IssueModel;
	private _githubRepositories: GitHubRepository[];
	private _allGitHubRemotes: GitHubRemote[] = [];
	private _mentionableUsers?: { [key: string]: IAccount[] };
	private _fetchMentionableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _assignableUsers?: { [key: string]: IAccount[] };
	private _teamReviewers?: { [key: string]: ITeam[] };
	private _fetchAssignableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _fetchTeamReviewersPromise?: Promise<{ [key: string]: ITeam[] }>;
	private _gitBlameCache: { [key: string]: string } = {};
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();
	private _addedUpstreamCount: number = 0;

	private _onDidMergePullRequest = new vscode.EventEmitter<void>();
	readonly onDidMergePullRequest = this._onDidMergePullRequest.event;

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<{ new: number | undefined, old: number | undefined }>();
	readonly onDidChangeActivePullRequest: vscode.Event<{ new: number | undefined, old: number | undefined }> = this._onDidChangeActivePullRequest.event;
	private _onDidChangeActiveIssue = new vscode.EventEmitter<void>();
	readonly onDidChangeActiveIssue: vscode.Event<void> = this._onDidChangeActiveIssue.event;

	private _onDidLoadRepositories = new vscode.EventEmitter<ReposManagerState>();
	readonly onDidLoadRepositories: vscode.Event<ReposManagerState> = this._onDidLoadRepositories.event;

	private _onDidChangeRepositories = new vscode.EventEmitter<void>();
	readonly onDidChangeRepositories: vscode.Event<void> = this._onDidChangeRepositories.event;

	private _onDidChangeAssignableUsers = new vscode.EventEmitter<IAccount[]>();
	readonly onDidChangeAssignableUsers: vscode.Event<IAccount[]> = this._onDidChangeAssignableUsers.event;

	private _onDidChangeGithubRepositories = new vscode.EventEmitter<GitHubRepository[]>();
	readonly onDidChangeGithubRepositories: vscode.Event<GitHubRepository[]> = this._onDidChangeGithubRepositories.event;

	private _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose: vscode.Event<void> = this._onDidDispose.event;

	constructor(
		public context: vscode.ExtensionContext,
		private _repository: Repository,
		public readonly telemetry: ITelemetry,
		private _git: GitApiImpl,
		private _credentialStore: CredentialStore,
	) {
		this._subs = [];
		this._githubRepositories = [];
		this._githubManager = new GitHubManager();

		this._subs.push(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${REMOTES}`)) {
					await this.updateRepositories();
				}
			}),
		);

		this._subs.push(_credentialStore.onDidInitialize(() => this.updateRepositories()));

		this.cleanStoredRepoState();
	}

	private cleanStoredRepoState() {
		const deleteDate: number = new Date().valueOf() - 30 /*days*/ * 86400000 /*milliseconds in a day*/;
		const reposState = this.context.globalState.get<ReposState>(REPO_KEYS);
		if (reposState?.repos) {
			let keysChanged = false;
			Object.keys(reposState.repos).forEach(repo => {
				const repoState = reposState.repos[repo];
				if ((repoState.stateModifiedTime ?? 0) < deleteDate) {
					keysChanged = true;
					delete reposState.repos[repo];
				}
			});
			if (keysChanged) {
				this.context.globalState.update(REPO_KEYS, reposState);
			}
		}
	}

	get gitHubRepositories(): GitHubRepository[] {
		return this._githubRepositories;
	}

	public async computeAllUnknownRemotes(): Promise<Remote[]> {
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		const serverTypes = await Promise.all(
			potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)),
		).catch(e => {
			Logger.error(`Resolving GitHub remotes failed: ${e}`);
			vscode.window.showErrorMessage(vscode.l10n.t('Resolving GitHub remotes failed: {0}', formatError(e)));
			return [];
		});
		const unknownRemotes: Remote[] = [];
		let i = 0;
		for (const potentialRemote of potentialRemotes) {
			if (serverTypes[i] === GitHubServerType.None) {
				unknownRemotes.push(potentialRemote);
			}
			i++;
		}
		return unknownRemotes;
	}

	public async computeAllGitHubRemotes(): Promise<GitHubRemote[]> {
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		const serverTypes = await Promise.all(
			potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)),
		).catch(e => {
			Logger.error(`Resolving GitHub remotes failed: ${e}`);
			vscode.window.showErrorMessage(vscode.l10n.t('Resolving GitHub remotes failed: {0}', formatError(e)));
			return [];
		});
		const githubRemotes: GitHubRemote[] = [];
		let i = 0;
		for (const potentialRemote of potentialRemotes) {
			if (serverTypes[i] !== GitHubServerType.None) {
				githubRemotes.push(GitHubRemote.remoteAsGitHub(potentialRemote, serverTypes[i]));
			}
			i++;
		}
		return githubRemotes;
	}

	public async getActiveGitHubRemotes(allGitHubRemotes: GitHubRemote[]): Promise<GitHubRemote[]> {
		const remotesSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(REMOTES);

		if (!remotesSetting) {
			Logger.error(`Unable to read remotes setting`);
			return Promise.resolve([]);
		}

		const missingRemotes = remotesSetting.filter(remote => {
			return !allGitHubRemotes.some(repo => repo.remoteName === remote);
		});

		if (missingRemotes.length === remotesSetting.length) {
			Logger.warn(`No remotes found. The following remotes are missing: ${missingRemotes.join(', ')}`);
		} else {
			Logger.debug(`Not all remotes found. The following remotes are missing: ${missingRemotes.join(', ')}`, FolderRepositoryManager.ID);
		}

		Logger.debug(`Displaying configured remotes: ${remotesSetting.join(', ')}`, FolderRepositoryManager.ID);

		return remotesSetting
			.map(remote => allGitHubRemotes.find(repo => repo.remoteName === remote))
			.filter((repo: GitHubRemote | undefined): repo is GitHubRemote => !!repo);
	}

	get activeIssue(): IssueModel | undefined {
		return this._activeIssue;
	}

	set activeIssue(issue: IssueModel | undefined) {
		this._activeIssue = issue;
		this._onDidChangeActiveIssue.fire();
	}

	get activePullRequest(): PullRequestModel | undefined {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: PullRequestModel | undefined) {
		const oldNumber = this._activePullRequest?.number;
		if (this._activePullRequest) {
			this._activePullRequest.isActive = false;
		}

		if (pullRequest) {
			pullRequest.isActive = true;
		}
		const newNumber = pullRequest?.number;

		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire({ old: oldNumber, new: newNumber });
	}

	get repository(): Repository {
		return this._repository;
	}

	set repository(repository: Repository) {
		this._repository = repository;
	}

	get credentialStore(): CredentialStore {
		return this._credentialStore;
	}

	/**
	 * Using these contexts is fragile in a multi-root workspace where multiple PRs are checked out.
	 * If you have two active PRs that have the same file path relative to their rootdir, then these context can get confused.
	 */
	public setFileViewedContext() {
		const states = this.activePullRequest?.getViewedFileStates();
		if (states) {
			commands.setContext(contexts.VIEWED_FILES, Array.from(states.viewed));
			commands.setContext(contexts.UNVIEWED_FILES, Array.from(states.unviewed));
		} else {
			this.clearFileViewedContext();
		}
	}

	private clearFileViewedContext() {
		commands.setContext(contexts.VIEWED_FILES, []);
		commands.setContext(contexts.UNVIEWED_FILES, []);
	}

	public async loginAndUpdate() {
		if (!this._credentialStore.isAnyAuthenticated()) {
			const waitForRepos = new Promise<void>(c => {
				const onReposChange = this.onDidChangeRepositories(() => {
					onReposChange.dispose();
					c();
				});
			});
			await this._credentialStore.login(AuthProvider.github);
			await waitForRepos;
		}
	}

	private async getActiveRemotes(): Promise<GitHubRemote[]> {
		this._allGitHubRemotes = await this.computeAllGitHubRemotes();
		const activeRemotes = await this.getActiveGitHubRemotes(this._allGitHubRemotes);

		if (activeRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
			Logger.appendLine(`Found GitHub remote for folder ${this.repository.rootUri.fsPath}`);
		} else {
			Logger.appendLine(`No GitHub remotes found for folder ${this.repository.rootUri.fsPath}`);
		}

		return activeRemotes;
	}

	private _updatingRepositories: Promise<void> | undefined;
	async updateRepositories(silent: boolean = false): Promise<void> {
		if (this._updatingRepositories) {
			await this._updatingRepositories;
		}
		this._updatingRepositories = this.doUpdateRepositories(silent);
		return this._updatingRepositories;
	}

	private checkForAuthMatch(activeRemotes: GitHubRemote[]): boolean {
		// Check that our auth matches the remote.
		let dotComCount = 0;
		let enterpriseCount = 0;
		for (const remote of activeRemotes) {
			if (remote.githubServerType === GitHubServerType.GitHubDotCom) {
				dotComCount++;
			} else if (remote.githubServerType === GitHubServerType.Enterprise) {
				enterpriseCount++;
			}
		}

		let isAuthenticated = this._credentialStore.isAuthenticated(AuthProvider.github) || this._credentialStore.isAuthenticated(AuthProvider.githubEnterprise);
		if ((dotComCount > 0) && this._credentialStore.isAuthenticated(AuthProvider.github)) {
			// good
		} else if ((enterpriseCount > 0) && this._credentialStore.isAuthenticated(AuthProvider.githubEnterprise)) {
			// also good
		} else if (isAuthenticated) {
			// Not good. We have a mismatch between auth type and server type.
			isAuthenticated = false;
		}
		vscode.commands.executeCommand('setContext', 'github:authenticated', isAuthenticated);
		return isAuthenticated;
	}

	private async doUpdateRepositories(silent: boolean): Promise<void> {
		if (this._git.state === 'uninitialized') {
			Logger.appendLine('Cannot updates repositories as git is uninitialized');

			return;
		}

		const activeRemotes = await this.getActiveRemotes();
		const isAuthenticated = this.checkForAuthMatch(activeRemotes);
		if (this.credentialStore.isAnyAuthenticated() && (activeRemotes.length === 0)) {
			const areAllNeverGitHub = (await this.computeAllUnknownRemotes()).every(remote => GitHubManager.isNeverGitHub(vscode.Uri.parse(remote.normalizedHost).authority));
			if (areAllNeverGitHub) {
				this._onDidLoadRepositories.fire(ReposManagerState.RepositoriesLoaded);
				return;
			}
		}
		const repositories: GitHubRepository[] = [];
		const resolveRemotePromises: Promise<boolean>[] = [];
		const oldRepositories: GitHubRepository[] = [];
		this._githubRepositories.forEach(repo => oldRepositories.push(repo));

		const authenticatedRemotes = activeRemotes.filter(remote => this._credentialStore.isAuthenticated(remote.authProviderId));
		for (const remote of authenticatedRemotes) {
			const repository = await this.createGitHubRepository(remote, this._credentialStore);
			resolveRemotePromises.push(repository.resolveRemote());
			repositories.push(repository);
		}

		return Promise.all(resolveRemotePromises).then(async (remoteResults: boolean[]) => {
			const missingSaml: string[] = [];
			for (let i = 0; i < remoteResults.length; i++) {
				if (!remoteResults[i]) {
					missingSaml.push(repositories[i].remote.owner);
				}
			}
			if (missingSaml.length > 0) {
				const result = await this._credentialStore.showSamlMessageAndAuth(missingSaml);
				if (result.canceled) {
					this.dispose();
					return;
				}
			}

			this._githubRepositories = repositories;
			oldRepositories.filter(old => this._githubRepositories.indexOf(old) < 0).forEach(repo => repo.dispose());

			const repositoriesChanged =
				oldRepositories.length !== this._githubRepositories.length ||
				!oldRepositories.every(oldRepo =>
					this._githubRepositories.some(newRepo => newRepo.remote.equals(oldRepo.remote)),
				);

			if (repositoriesChanged) {
				this._onDidChangeGithubRepositories.fire(this._githubRepositories);
			}

			if (this._githubRepositories.length && repositoriesChanged) {
				if (await this.checkIfMissingUpstream()) {
					this.updateRepositories(silent);
					return;
				}
			}

			if (this.activePullRequest) {
				this.getMentionableUsers(repositoriesChanged);
			}

			this.getAssignableUsers(repositoriesChanged);
			if (isAuthenticated && activeRemotes.length) {
				this._onDidLoadRepositories.fire(ReposManagerState.RepositoriesLoaded);
			} else if (!isAuthenticated) {
				this._onDidLoadRepositories.fire(ReposManagerState.NeedsAuthentication);
			}
			if (!silent) {
				this._onDidChangeRepositories.fire();
			}
			return;
		});
	}

	private async checkIfMissingUpstream(): Promise<boolean> {
		try {
			const origin = await this.getOrigin();
			const metadata = await origin.getMetadata();
			const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
			if (metadata.fork && metadata.parent && (configuration.get<'add' | 'never'>(UPSTREAM_REMOTE, 'add') === 'add')) {
				const parentUrl = new Protocol(metadata.parent.git_url);
				const missingParentRemote = !this._githubRepositories.some(
					repo =>
						repo.remote.owner === parentUrl.owner &&
						repo.remote.repositoryName === parentUrl.repositoryName,
				);

				if (missingParentRemote) {
					const upstreamAvailable = !this.repository.state.remotes.some(remote => remote.name === 'upstream');
					const remoteName = upstreamAvailable ? 'upstream' : metadata.parent.owner?.login;
					if (remoteName) {
						// check the remotes to see what protocol is being used
						const isSSH = this.gitHubRepositories[0].remote.gitProtocol.type === ProtocolType.SSH;
						if (isSSH) {
							await this.repository.addRemote(remoteName, metadata.parent.ssh_url);
						} else {
							await this.repository.addRemote(remoteName, metadata.parent.clone_url);
						}
						this._addedUpstreamCount++;
						if (this._addedUpstreamCount > 1) {
							// We've already added this remote, which means the user likely removed it. Let the user know they can disable this feature.
							const neverOption = vscode.l10n.t('Set to `never`');
							vscode.window.showInformationMessage(vscode.l10n.t('An `upstream` remote has been added for this repository. You can disable this feature by setting `githubPullRequests.upstreamRemote` to `never`.'), neverOption)
								.then(choice => {
									if (choice === neverOption) {
										configuration.update(UPSTREAM_REMOTE, 'never', vscode.ConfigurationTarget.Global);
									}
								});
						}
						return true;
					}
				}
			}
		} catch (e) {
			Logger.appendLine(`Missing upstream check failed: ${e}`);
			// ignore
		}
		return false;
	}

	getAllAssignableUsers(): IAccount[] | undefined {
		if (this._assignableUsers) {
			const allAssignableUsers: IAccount[] = [];
			Object.keys(this._assignableUsers).forEach(k => {
				allAssignableUsers.push(...this._assignableUsers![k]);
			});

			return allAssignableUsers;
		}

		return undefined;
	}

	private async getUsersFromGlobalState<T extends IAccount | ITeam>(userKind: 'assignableUsers' | 'teamReviewers' | 'mentionableUsers'): Promise<{ [key: string]: T[] } | undefined> {
		Logger.appendLine(`Trying to use globalState for ${userKind}.`);

		const usersCacheLocation = vscode.Uri.joinPath(this.context.globalStorageUri, userKind);
		let usersCacheExists;
		try {
			usersCacheExists = await vscode.workspace.fs.stat(usersCacheLocation);
		} catch (e) {
			// file doesn't exit
		}
		if (!usersCacheExists) {
			Logger.appendLine(`GlobalState does not exist for ${userKind}.`);
			return undefined;
		}

		const cache: { [key: string]: T[] } = {};
		const hasAllRepos = (await Promise.all(this._githubRepositories.map(async (repo) => {
			const key = `${repo.remote.owner}/${repo.remote.repositoryName}.json`;
			const repoSpecificFile = vscode.Uri.joinPath(usersCacheLocation, key);
			let repoSpecificCache;
			let cacheAsJson;
			try {
				repoSpecificCache = await vscode.workspace.fs.readFile(repoSpecificFile);
				cacheAsJson = JSON.parse(repoSpecificCache.toString());
			} catch (e) {
				if (e instanceof Error && e.message.includes('Unexpected non-whitespace character after JSON')) {
					Logger.error(`Error parsing ${userKind} cache for ${repo.remote.remoteName}.`);
				}
				// file doesn't exist
			}
			if (repoSpecificCache && repoSpecificCache.toString()) {
				cache[repo.remote.remoteName] = cacheAsJson ?? [];
				return true;
			}
		}))).every(value => value);
		if (hasAllRepos) {
			Logger.appendLine(`Using globalState ${userKind} for ${Object.keys(cache).length}.`);
			return cache;
		}

		Logger.appendLine(`No globalState for ${userKind}.`);
		return undefined;
	}

	private async saveUsersInGlobalState<T extends IAccount | ITeam>(userKind: 'assignableUsers' | 'teamReviewers' | 'mentionableUsers', cache: { [key: string]: T[] }): Promise<void> {
		const cacheLocation = vscode.Uri.joinPath(this.context.globalStorageUri, userKind);
		await Promise.all(this._githubRepositories.map(async (repo) => {
			const key = `${repo.remote.owner}/${repo.remote.repositoryName}.json`;
			const repoSpecificFile = vscode.Uri.joinPath(cacheLocation, key);
			await vscode.workspace.fs.writeFile(repoSpecificFile, new TextEncoder().encode(JSON.stringify(cache[repo.remote.remoteName])));
		}));
	}

	private createFetchMentionableUsersPromise(): Promise<{ [key: string]: IAccount[] }> {
		const cache: { [key: string]: IAccount[] } = {};
		return new Promise<{ [key: string]: IAccount[] }>(resolve => {
			const promises = this._githubRepositories.map(async githubRepository => {
				const data = await githubRepository.getMentionableUsers();
				cache[githubRepository.remote.remoteName] = data;
				return;
			});

			Promise.all(promises).then(() => {
				this._mentionableUsers = cache;
				this._fetchMentionableUsersPromise = undefined;
				this.saveUsersInGlobalState('mentionableUsers', cache)
					.then(() => resolve(cache));
			});
		});
	}

	async getMentionableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._mentionableUsers;
		}

		if (this._mentionableUsers) {
			Logger.appendLine('Using in-memory cached mentionable users.');
			return this._mentionableUsers;
		}

		const globalStateMentionableUsers = await this.getUsersFromGlobalState<IAccount>('mentionableUsers');

		if (!this._fetchMentionableUsersPromise) {
			this._fetchMentionableUsersPromise = this.createFetchMentionableUsersPromise();
			return globalStateMentionableUsers ?? this._fetchMentionableUsersPromise;
		}

		return this._fetchMentionableUsersPromise;
	}

	async getAssignableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._assignableUsers;
		}

		if (this._assignableUsers) {
			Logger.appendLine('Using in-memory cached assignable users.');
			return this._assignableUsers;
		}

		const globalStateAssignableUsers = await this.getUsersFromGlobalState<IAccount>('assignableUsers');

		if (!this._fetchAssignableUsersPromise) {
			const cache: { [key: string]: IAccount[] } = {};
			const allAssignableUsers: IAccount[] = [];
			this._fetchAssignableUsersPromise = new Promise(resolve => {
				const promises = this._githubRepositories.map(async githubRepository => {
					const data = await githubRepository.getAssignableUsers();
					cache[githubRepository.remote.remoteName] = data.sort(loginComparator);
					allAssignableUsers.push(...data);
					return;
				});

				Promise.all(promises).then(() => {
					this._assignableUsers = cache;
					this._fetchAssignableUsersPromise = undefined;
					this.saveUsersInGlobalState('assignableUsers', cache);
					resolve(cache);
					this._onDidChangeAssignableUsers.fire(allAssignableUsers);
				});
			});
			return globalStateAssignableUsers ?? this._fetchAssignableUsersPromise;
		}

		return this._fetchAssignableUsersPromise;
	}

	async getTeamReviewers(refreshKind: TeamReviewerRefreshKind): Promise<{ [key: string]: ITeam[] }> {
		if (refreshKind === TeamReviewerRefreshKind.Force) {
			delete this._teamReviewers;
		}

		if (this._teamReviewers) {
			Logger.appendLine('Using in-memory cached team reviewers.');
			return this._teamReviewers;
		}

		const globalStateTeamReviewers = (refreshKind === TeamReviewerRefreshKind.Force) ? undefined : await this.getUsersFromGlobalState<ITeam>('teamReviewers');
		if (globalStateTeamReviewers) {
			this._teamReviewers = globalStateTeamReviewers;
			return globalStateTeamReviewers || {};
		}

		if (!this._fetchTeamReviewersPromise) {
			const cache: { [key: string]: ITeam[] } = {};
			return (this._fetchTeamReviewersPromise = new Promise(async (resolve) => {
				// Keep track of the org teams we have already gotten so we don't make duplicate calls
				const orgTeams: Map<string, (ITeam & { repositoryNames: string[] })[]> = new Map();
				// Go through one github repo at a time so that we don't make overlapping auth calls
				for (const githubRepository of this._githubRepositories) {
					if (!orgTeams.has(githubRepository.remote.owner)) {
						try {
							const data = await githubRepository.getOrgTeams(refreshKind);
							orgTeams.set(githubRepository.remote.owner, data);
						} catch (e) {
							break;
						}
					}
					const allTeamsForOrg = orgTeams.get(githubRepository.remote.owner) ?? [];
					cache[githubRepository.remote.remoteName] = allTeamsForOrg.filter(team => team.repositoryNames.includes(githubRepository.remote.repositoryName)).sort(teamComparator);
				}

				this._teamReviewers = cache;
				this._fetchTeamReviewersPromise = undefined;
				this.saveUsersInGlobalState('teamReviewers', cache);
				resolve(cache);
			}));
		}

		return this._fetchTeamReviewersPromise;
	}

	async getOrgTeamsCount(repository: GitHubRepository): Promise<number> {
		if ((await repository.getMetadata()).organization) {
			return repository.getOrgTeamsCount();
		}
		return 0;
	}

	async getPullRequestParticipants(githubRepository: GitHubRepository, pullRequestNumber: number): Promise<{ participants: IAccount[], viewer: IAccount }> {
		return {
			participants: await githubRepository.getPullRequestParticipants(pullRequestNumber),
			viewer: await this.getCurrentUser(githubRepository)
		};
	}

	/**
	 * Returns the remotes that are currently active, which is those that are important by convention (origin, upstream),
	 * or the remotes configured by the setting githubPullRequests.remotes
	 */
	async getGitHubRemotes(): Promise<GitHubRemote[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const remotes = githubRepositories.map(repo => repo.remote).flat();

		const serverTypes = await Promise.all(
			remotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)),
		).catch(e => {
			Logger.error(`Resolving GitHub remotes failed: ${e}`);
			vscode.window.showErrorMessage(vscode.l10n.t('Resolving GitHub remotes failed: {0}', formatError(e)));
			return [];
		});

		const githubRemotes = remotes.map((remote, index) => GitHubRemote.remoteAsGitHub(remote, serverTypes[index]));
		if (this.checkForAuthMatch(githubRemotes)) {
			return githubRemotes;
		}
		return [];
	}

	/**
	 * Returns all remotes from the repository.
	 */
	async getAllGitHubRemotes(): Promise<GitHubRemote[]> {
		return await this.computeAllGitHubRemotes();
	}

	async getLocalPullRequests(): Promise<PullRequestModel[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = (await this.repository.getRefs({ pattern: 'refs/heads/' }))
			.filter(r => r.name !== undefined)
			.map(r => r.name!);

		// Chunk localBranches into chunks of 100 to avoid hitting the GitHub API rate limit
		const chunkedLocalBranches: string[][] = [];
		const chunkSize = 100;
		for (let i = 0; i < localBranches.length; i += chunkSize) {
			const chunk = localBranches.slice(i, i + chunkSize);
			chunkedLocalBranches.push(chunk);
		}

		const models: (PullRequestModel | undefined)[] = [];
		for (const chunk of chunkedLocalBranches) {
			models.push(...await Promise.all(chunk.map(async localBranchName => {
				const matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(
					this.repository,
					localBranchName,
				);

				if (matchingPRMetadata) {
					const { owner, prNumber } = matchingPRMetadata;
					const githubRepo = githubRepositories.find(
						repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase(),
					);

					if (githubRepo) {
						const pullRequest: PullRequestModel | undefined = await githubRepo.getPullRequest(prNumber);

						if (pullRequest) {
							pullRequest.localBranchName = localBranchName;
							return pullRequest;
						}
					}
				}
			})));
		}

		return models.filter(value => value !== undefined) as PullRequestModel[];
	}

	async getLabels(issue?: IssueModel, repoInfo?: { owner: string; repo: string }): Promise<ILabel[]> {
		const repo = issue
			? issue.githubRepository
			: this._githubRepositories.find(
				r => r.remote.owner === repoInfo?.owner && r.remote.repositoryName === repoInfo?.repo,
			);
		if (!repo) {
			throw new Error(`No matching repository found for getting labels.`);
		}

		const { remote, octokit } = await repo.ensure();
		let hasNextPage = false;
		let page = 1;
		let results: ILabel[] = [];

		do {
			const result = await octokit.call(octokit.api.issues.listLabelsForRepo, {
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: 100,
				page,
			});

			results = results.concat(
				result.data.map(label => {
					return {
						name: label.name,
						color: label.color,
						description: label.description ?? undefined
					};
				}),
			);

			results = results.sort((a, b) => a.name.localeCompare(b.name));

			hasNextPage = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			page += 1;
		} while (hasNextPage);

		return results;
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel, force?: boolean): Promise<void> {
		if (!pullRequest.localBranchName) {
			return;
		}
		await this.repository.deleteBranch(pullRequest.localBranchName, force);

		let remoteName: string | undefined = undefined;
		try {
			remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		} catch (e) { }

		if (!remoteName) {
			return;
		}

		// If the extension created a remote for the branch, remove it if there are no other branches associated with it
		const isPRRemote = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remoteName);
		if (isPRRemote) {
			const configs = await this.repository.getConfigs();
			const hasOtherAssociatedBranches = configs.some(
				({ key, value }) => /^branch.*\.remote$/.test(key) && value === remoteName,
			);

			if (!hasOtherAssociatedBranches) {
				await this.repository.removeRemote(remoteName);
			}
		}

		/* __GDPR__
			"branch.delete" : {}
		*/
		this.telemetry.sendTelemetryEvent('branch.delete');
	}

	// Keep track of how many pages we've fetched for each query, so when we reload we pull the same ones.
	private totalFetchedPages = new Map<string, number>();

	/**
	 * This method works in three different ways:
	 * 1) Initialize: fetch the first page of the first remote that has pages
	 * 2) Fetch Next: fetch the next page from this remote, or if it has no more pages, the first page from the next remote that does have pages
	 * 3) Restore: fetch all the pages you previously have fetched
	 *
	 * When `options.fetchNextPage === false`, we are in case 2.
	 * Otherwise:
	 *   If `this.totalFetchQueries[queryId] === 0`, we are in case 1.
	 *   Otherwise, we're in case 3.
	 */
	private async fetchPagedData<T>(
		options: IPullRequestsPagingOptions = { fetchNextPage: false },
		queryId: string,
		pagedDataType: PagedDataType = PagedDataType.PullRequest,
		type: PRType = PRType.All,
		query?: string,
	): Promise<ItemsResponseResult<T>> {
		const githubRepositoriesWithGitRemotes = pagedDataType === PagedDataType.PullRequest ? this._githubRepositories.filter(repo => this.repository.state.remotes.find(r => r.name === repo.remote.remoteName)) : this._githubRepositories;
		if (!githubRepositoriesWithGitRemotes.length) {
			return {
				items: [],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};
		}

		const getTotalFetchedPages = () => this.totalFetchedPages.get(queryId) || 0;
		const setTotalFetchedPages = (numPages: number) => this.totalFetchedPages.set(queryId, numPages);

		for (const repository of githubRepositoriesWithGitRemotes) {
			const remoteId = repository.remote.url.toString() + queryId;
			if (!this._repositoryPageInformation.get(remoteId)) {
				this._repositoryPageInformation.set(remoteId, {
					pullRequestPage: 0,
					hasMorePages: null,
				});
			}
		}

		let pagesFetched = 0;
		const itemData: ItemsData = { hasMorePages: false, items: [] };
		const addPage = (page: PullRequestData | undefined) => {
			pagesFetched++;
			if (page) {
				itemData.items = itemData.items.concat(page.items);
				itemData.hasMorePages = page.hasMorePages;
			}
		};

		const githubRepositories = this._githubRepositories.filter(repo => {
			const info = this._repositoryPageInformation.get(repo.remote.url.toString() + queryId);
			// If we are in case 1 or 3, don't filter out repos that are out of pages, as we will be querying from the start.
			return info && (options.fetchNextPage === false || info.hasMorePages !== false);
		});

		for (let i = 0; i < githubRepositories.length; i++) {
			const githubRepository = githubRepositories[i];
			const remoteId = githubRepository.remote.url.toString() + queryId;
			let storedPageInfo = this._repositoryPageInformation.get(remoteId);
			if (!storedPageInfo) {
				Logger.warn(`No page information for ${remoteId}`);
				storedPageInfo = { pullRequestPage: 0, hasMorePages: null };
				this._repositoryPageInformation.set(remoteId, storedPageInfo);
			}
			const pageInformation = storedPageInfo;

			const fetchPage = async (
				pageNumber: number,
			): Promise<{ items: any[]; hasMorePages: boolean } | undefined> => {
				// Resolve variables in the query with each repo
				const resolvedQuery = query ? await variableSubstitution(query, undefined,
					{ base: await githubRepository.getDefaultBranch(), owner: githubRepository.remote.owner, repo: githubRepository.remote.repositoryName }) : undefined;
				switch (pagedDataType) {
					case PagedDataType.PullRequest: {
						if (type === PRType.All) {
							return githubRepository.getAllPullRequests(pageNumber);
						} else {
							return githubRepository.getPullRequestsForCategory(resolvedQuery || '', pageNumber);
						}
					}
					case PagedDataType.Milestones: {
						return githubRepository.getIssuesForUserByMilestone(pageInformation.pullRequestPage);
					}
					case PagedDataType.IssuesWithoutMilestone: {
						return githubRepository.getIssuesWithoutMilestone(pageInformation.pullRequestPage);
					}
					case PagedDataType.IssueSearch: {
						return githubRepository.getIssues(pageInformation.pullRequestPage, resolvedQuery);
					}
				}
			};

			if (options.fetchNextPage) {
				// Case 2. Fetch a single new page, and increment the global number of pages fetched for this query.
				pageInformation.pullRequestPage++;
				addPage(await fetchPage(pageInformation.pullRequestPage));
				setTotalFetchedPages(getTotalFetchedPages() + 1);
			} else {
				// Case 1&3. Fetch all the pages we have fetched in the past, or in case 1, just a single page.

				if (pageInformation.pullRequestPage === 0) {
					// Case 1. Pretend we have previously fetched the first page, then hand off to the case 3 machinery to "fetch all pages we have fetched in the past"
					pageInformation.pullRequestPage = 1;
				}

				const pages = await Promise.all(
					Array.from({ length: pageInformation.pullRequestPage }).map((_, j) => fetchPage(j + 1)),
				);
				pages.forEach(page => addPage(page));
			}

			pageInformation.hasMorePages = itemData.hasMorePages;

			// Break early if
			// 1) we've received data AND
			// 2) either we're fetching just the next page (case 2)
			//    OR we're fetching all (cases 1&3), and we've fetched as far as we had previously (or further, in case 1).
			if (
				itemData.items.length &&
				(options.fetchNextPage ||
					((options.fetchNextPage === false) && !options.fetchOnePagePerRepo && (pagesFetched >= getTotalFetchedPages())))
			) {
				if (getTotalFetchedPages() === 0) {
					// We're in case 1, manually set number of pages we looked through until we found first results.
					setTotalFetchedPages(pagesFetched);
				}

				return {
					items: itemData.items,
					hasMorePages: pageInformation.hasMorePages,
					hasUnsearchedRepositories: i < githubRepositories.length - 1,
				};
			}
		}

		return {
			items: itemData.items,
			hasMorePages: false,
			hasUnsearchedRepositories: false,
		};
	}

	async getPullRequests(
		type: PRType,
		options: IPullRequestsPagingOptions = { fetchNextPage: false },
		query?: string,
	): Promise<ItemsResponseResult<PullRequestModel>> {
		const queryId = type.toString() + (query || '');
		return this.fetchPagedData<PullRequestModel>(options, queryId, PagedDataType.PullRequest, type, query);
	}

	async getMilestoneIssues(
		options: IPullRequestsPagingOptions = { fetchNextPage: false },
		includeIssuesWithoutMilestone: boolean = false,
	): Promise<ItemsResponseResult<MilestoneModel>> {
		const milestones: ItemsResponseResult<MilestoneModel> = await this.fetchPagedData<MilestoneModel>(
			options,
			'milestoneIssuesKey',
			PagedDataType.Milestones,
			PRType.All
		);
		if (includeIssuesWithoutMilestone) {
			const additionalIssues: ItemsResponseResult<Issue> = await this.fetchPagedData<Issue>(
				options,
				'noMilestoneIssuesKey',
				PagedDataType.IssuesWithoutMilestone,
				PRType.All
			);
			milestones.items.push({
				milestone: {
					createdAt: new Date(0).toDateString(),
					id: '',
					title: NO_MILESTONE,
				},
				issues: await Promise.all(additionalIssues.items.map(async (issue) => {
					const githubRepository = await this.getRepoForIssue(issue);
					return new IssueModel(githubRepository, githubRepository.remote, issue);
				})),
			});
		}
		return milestones;
	}

	async createMilestone(repository: GitHubRepository, milestoneTitle: string): Promise<IMilestone | undefined> {
		try {
			const { data } = await repository.octokit.call(repository.octokit.api.issues.createMilestone, {
				owner: repository.remote.owner,
				repo: repository.remote.repositoryName,
				title: milestoneTitle
			});
			return {
				title: data.title,
				dueOn: data.due_on,
				createdAt: data.created_at,
				id: data.node_id,
			};
		}
		catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to create a milestone\n{0}', formatError(e)));
			return undefined;
		}
	}

	private async getRepoForIssue(parsedIssue: Issue): Promise<GitHubRepository> {
		const remote = new Remote(
			parsedIssue.repositoryName!,
			parsedIssue.repositoryUrl!,
			new Protocol(parsedIssue.repositoryUrl!),
		);
		return this.createGitHubRepository(remote, this.credentialStore, true, true);

	}

	/**
	 * Pull request defaults in the query, like owner and repository variables, will be resolved.
	 */
	async getIssues(
		query?: string,
	): Promise<ItemsResponseResult<IssueModel>> {
		const data = await this.fetchPagedData<Issue>({ fetchNextPage: false, fetchOnePagePerRepo: false }, `issuesKey${query}`, PagedDataType.IssueSearch, PRType.All, query);
		const mappedData: ItemsResponseResult<IssueModel> = {
			items: [],
			hasMorePages: data.hasMorePages,
			hasUnsearchedRepositories: data.hasUnsearchedRepositories
		};
		for (const issue of data.items) {
			const githubRepository = await this.getRepoForIssue(issue);
			mappedData.items.push(new IssueModel(githubRepository, githubRepository.remote, issue));
		}
		return mappedData;
	}

	async getMaxIssue(): Promise<number> {
		const maxIssues = await Promise.all(
			this._githubRepositories.map(repository => {
				return repository.getMaxIssue();
			}),
		);
		let max: number = 0;
		for (const issueNumber of maxIssues) {
			if (issueNumber !== undefined) {
				max = Math.max(max, issueNumber);
			}
		}
		return max;
	}

	async getPullRequestTemplates(): Promise<vscode.Uri[]> {
		/**
		 * Places a PR template can be:
		 * - At the root, the docs folder, or the.github folder, named pull_request_template.md or PULL_REQUEST_TEMPLATE.md
		 * - At the same folder locations under a PULL_REQUEST_TEMPLATE folder with any name
		 */
		const pattern1 = '{pull_request_template,PULL_REQUEST_TEMPLATE}.{md,txt}';
		const templatesPattern1 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern1)
		);

		const pattern2 = '{docs,.github}/{pull_request_template,PULL_REQUEST_TEMPLATE}.{md,txt}';
		const templatesPattern2 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern2), null
		);

		const pattern3 = '{pull_request_template,PULL_REQUEST_TEMPLATE}';
		const templatesPattern3 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern3)
		);

		const pattern4 = '{docs,.github}/{pull_request_template,PULL_REQUEST_TEMPLATE}';
		const templatesPattern4 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern4), null
		);

		const pattern5 = 'PULL_REQUEST_TEMPLATE/*.md';
		const templatesPattern5 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern5)
		);

		const pattern6 = '{docs,.github}/PULL_REQUEST_TEMPLATE/*.md';
		const templatesPattern6 = vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern6), null
		);

		const allResults = await Promise.all([templatesPattern1, templatesPattern2, templatesPattern3, templatesPattern4, templatesPattern5, templatesPattern6]);

		return [...allResults[0], ...allResults[1], ...allResults[2], ...allResults[3], ...allResults[4], ...allResults[5]];
	}

	async getPullRequestDefaults(branch?: Branch): Promise<PullRequestDefaults> {
		if (!branch && !this.repository.state.HEAD) {
			throw new DetachedHeadError(this.repository);
		}

		const origin = await this.getOrigin(branch);
		const meta = await origin.getMetadata();
		const remotesSettingDefault = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).inspect<string[]>(REMOTES)?.defaultValue;
		const remotesSettingSetValue = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(REMOTES);
		const settingsEqual = (!remotesSettingSetValue || remotesSettingDefault?.every((value, index) => remotesSettingSetValue[index] === value));
		const parent = (meta.fork && meta.parent && settingsEqual)
			? meta.parent
			: await (this.findRepo(byRemoteName('upstream')) || origin).getMetadata();

		return {
			owner: parent.owner!.login,
			repo: parent.name,
			base: getOverrideBranch() ?? parent.default_branch,
		};
	}

	async getMetadata(remote: string): Promise<any> {
		const repo = this.findRepo(byRemoteName(remote));
		return repo && repo.getMetadata();
	}

	async getHeadCommitMessage(): Promise<string> {
		const { repository } = this;
		if (repository.state.HEAD && repository.state.HEAD.commit) {
			const { message } = await repository.getCommit(repository.state.HEAD.commit);
			return message;
		}

		return '';
	}

	async getTipCommitMessage(branch: string): Promise<string> {
		const { repository } = this;
		const { commit } = await repository.getBranch(branch);
		if (commit) {
			const { message } = await repository.getCommit(commit);
			return message;
		}

		return '';
	}

	async getOrigin(branch?: Branch): Promise<GitHubRepository> {
		if (!this._githubRepositories.length) {
			throw new NoGitHubReposError(this.repository);
		}

		const upstreamRef = branch ? branch.upstream : this.upstreamRef;
		if (upstreamRef) {
			// If our current branch has an upstream ref set, find its GitHubRepository.
			const upstream = this.findRepo(byRemoteName(upstreamRef.remote));

			// If the upstream wasn't listed in the remotes setting, create a GitHubRepository
			// object for it if is does point to GitHub.
			if (!upstream) {
				const remote = (await this.getAllGitHubRemotes()).find(r => r.remoteName === upstreamRef.remote);
				if (remote) {
					return this.createAndAddGitHubRepository(remote, this._credentialStore);
				}

				Logger.error(`The remote '${upstreamRef.remote}' is not a GitHub repository.`);

				// No GitHubRepository? We currently won't try pushing elsewhere,
				// so fail.
				throw new BadUpstreamError(this.repository.state.HEAD!.name!, upstreamRef, 'is not a GitHub repo');
			}

			// Otherwise, we'll push upstream.
			return upstream;
		}

		// If no upstream is set, let's go digging.
		const [first, ...rest] = this._githubRepositories;
		return !rest.length // Is there only one GitHub remote?
			? first // I GUESS THAT'S WHAT WE'RE GOING WITH, THEN.
			: // Otherwise, let's try...
			this.findRepo(byRemoteName('origin')) || // by convention
			this.findRepo(ownedByMe) || // bc maybe we can push there
			first; // out of raw desperation
	}

	findRepo(where: Predicate<GitHubRepository>): GitHubRepository | undefined {
		return this._githubRepositories.filter(where)[0];
	}

	get upstreamRef(): UpstreamRef | undefined {
		const { HEAD } = this.repository.state;
		return HEAD && HEAD.upstream;
	}

	async createPullRequest(params: OctokitCommon.PullsCreateParams): Promise<PullRequestModel | undefined> {
		const repo = this._githubRepositories.find(
			r => r.remote.owner === params.owner && r.remote.repositoryName === params.repo,
		);
		if (!repo) {
			throw new Error(`No matching repository ${params.repo} found for ${params.owner}`);
		}

		let pullRequestModel: PullRequestModel | undefined;
		try {
			pullRequestModel = await repo.createPullRequest(params);

			const branchNameSeparatorIndex = params.head.indexOf(':');
			const branchName = params.head.slice(branchNameSeparatorIndex + 1);
			await PullRequestGitHelper.associateBranchWithPullRequest(this._repository, pullRequestModel, branchName);

			/* __GDPR__
				"pr.create.success" : {
					"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryEvent('pr.create.success', { isDraft: (params.draft || '').toString() });
			return pullRequestModel;
		} catch (e) {
			if (e.message.indexOf('No commits between ') > -1) {
				// There are unpushed commits
				if (this._repository.state.HEAD?.ahead) {
					// Offer to push changes
					const pushCommits = vscode.l10n.t({ message: 'Push Commits', comment: 'Pushes the local commits to the remote.' });
					const shouldPush = await vscode.window.showInformationMessage(
						vscode.l10n.t('There are no commits between \'{0}\' and \'{1}\'.\n\nDo you want to push your local commits and create the pull request?', params.base, params.head),
						{ modal: true },
						pushCommits,
					);
					if (shouldPush === pushCommits) {
						await this._repository.push();
						return this.createPullRequest(params);
					} else {
						return;
					}
				}

				// There are uncommitted changes
				if (this._repository.state.workingTreeChanges.length || this._repository.state.indexChanges.length) {
					const commitChanges = vscode.l10n.t('Commit Changes');
					const shouldCommit = await vscode.window.showInformationMessage(
						vscode.l10n.t('There are no commits between \'{0}\' and \'{1}\'.\n\nDo you want to commit your changes and create the pull request?', params.base, params.head),
						{ modal: true },
						commitChanges,
					);
					if (shouldCommit === commitChanges) {
						await this._repository.add(this._repository.state.indexChanges.map(change => change.uri.fsPath));
						await this.repository.commit(`${params.title}${params.body ? `\n${params.body}` : ''}`);
						await this._repository.push();
						return this.createPullRequest(params);
					} else {
						return;
					}
				}
			}

			Logger.error(`Creating pull requests failed: ${e}`, FolderRepositoryManager.ID);

			/* __GDPR__
				"pr.create.failure" : {
					"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('pr.create.failure', {
				isDraft: (params.draft || '').toString(),
			});

			if (pullRequestModel) {
				// We have created the pull request but something else failed (ex., modifying the git config)
				// We shouldn't show an error as the pull request was successfully created
				return pullRequestModel;
			}
			throw new Error(formatError(e));
		}
	}

	async createIssue(params: OctokitCommon.IssuesCreateParams): Promise<IssueModel | undefined> {
		try {
			const repo = this._githubRepositories.find(
				r => r.remote.owner === params.owner && r.remote.repositoryName === params.repo,
			);
			if (!repo) {
				throw new Error(`No matching repository ${params.repo} found for ${params.owner}`);
			}

			await repo.ensure();

			// Create PR
			const { data } = await repo.octokit.call(repo.octokit.api.issues.create, params);
			const item = convertRESTIssueToRawPullRequest(data, repo);
			const issueModel = new IssueModel(repo, repo.remote, item);

			/* __GDPR__
				"issue.create.success" : {
				}
			*/
			this.telemetry.sendTelemetryEvent('issue.create.success');
			return issueModel;
		} catch (e) {
			Logger.error(` Creating issue failed: ${e}`, FolderRepositoryManager.ID);

			/* __GDPR__
				"issue.create.failure" : {}
			*/
			this.telemetry.sendTelemetryErrorEvent('issue.create.failure');
			vscode.window.showWarningMessage(vscode.l10n.t('Creating issue failed: {0}', formatError(e)));
		}

		return undefined;
	}

	async assignIssue(issue: IssueModel, login: string): Promise<void> {
		try {
			const repo = this._githubRepositories.find(
				r => r.remote.owner === issue.remote.owner && r.remote.repositoryName === issue.remote.repositoryName,
			);
			if (!repo) {
				throw new Error(
					`No matching repository ${issue.remote.repositoryName} found for ${issue.remote.owner}`,
				);
			}

			await repo.ensure();

			const param: OctokitCommon.IssuesAssignParams = {
				assignees: [login],
				owner: issue.remote.owner,
				repo: issue.remote.repositoryName,
				issue_number: issue.number,
			};
			await repo.octokit.call(repo.octokit.api.issues.addAssignees, param);

			/* __GDPR__
				"issue.assign.success" : {
				}
			*/
			this.telemetry.sendTelemetryEvent('issue.assign.success');
		} catch (e) {
			Logger.error(`Assigning issue failed: ${e}`, FolderRepositoryManager.ID);

			/* __GDPR__
				"issue.assign.failure" : {
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('issue.assign.failure');
			vscode.window.showWarningMessage(vscode.l10n.t('Assigning issue failed: {0}', formatError(e)));
		}
	}

	getCurrentUser(githubRepository?: GitHubRepository): Promise<IAccount> {
		if (!githubRepository) {
			githubRepository = this.gitHubRepositories[0];
		}
		return this._credentialStore.getCurrentUser(githubRepository.remote.authProviderId);
	}

	async mergePullRequest(
		pullRequest: PullRequestModel,
		title?: string,
		description?: string,
		method?: 'merge' | 'squash' | 'rebase',
	): Promise<any> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const activePRSHA = this.activePullRequest && this.activePullRequest.head && this.activePullRequest.head.sha;
		const workingDirectorySHA = this.repository.state.HEAD && this.repository.state.HEAD.commit;
		const mergingPRSHA = pullRequest.head && pullRequest.head.sha;
		const workingDirectoryIsDirty = this.repository.state.workingTreeChanges.length > 0;

		if (activePRSHA === mergingPRSHA) {
			// We're on the branch of the pr being merged.

			if (workingDirectorySHA !== mergingPRSHA) {
				// We are looking at different commit than what will be merged
				const { ahead } = this.repository.state.HEAD!;
				const pluralMessage = vscode.l10n.t('You have {0} unpushed commits on this PR branch.\n\nWould you like to proceed anyway?', ahead ?? 'unknown');
				const singularMessage = vscode.l10n.t('You have 1 unpushed commit on this PR branch.\n\nWould you like to proceed anyway?');
				if (ahead &&
					(await vscode.window.showWarningMessage(
						ahead > 1 ? pluralMessage : singularMessage,
						{ modal: true },
						vscode.l10n.t('Yes'),
					)) === undefined) {

					return {
						merged: false,
						message: 'unpushed changes',
					};
				}
			}

			if (workingDirectoryIsDirty) {
				// We have made changes to the PR that are not committed
				if (
					(await vscode.window.showWarningMessage(
						vscode.l10n.t('You have uncommitted changes on this PR branch.\n\n Would you like to proceed anyway?'),
						{ modal: true },
						vscode.l10n.t('Yes'),
					)) === undefined
				) {
					return {
						merged: false,
						message: 'uncommitted changes',
					};
				}
			}
		}

		return await octokit.call(octokit.api.pulls.merge, {
			commit_message: description,
			commit_title: title,
			merge_method:
				method ||
				vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'merge' | 'squash' | 'rebase'>(DEFAULT_MERGE_METHOD),
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.number,
		})
			.then(x => {
				/* __GDPR__
					"pr.merge.success" : {}
				*/
				this.telemetry.sendTelemetryEvent('pr.merge.success');
				this._onDidMergePullRequest.fire();
				return x.data;
			})
			.catch(e => {
				/* __GDPR__
					"pr.merge.failure" : {}
				*/
				this.telemetry.sendTelemetryErrorEvent('pr.merge.failure');
				throw e;
			});
	}

	async deleteBranch(pullRequest: PullRequestModel) {
		await pullRequest.githubRepository.deleteBranch(pullRequest);
	}

	private async getBranchDeletionItems() {
		const allConfigs = await this.repository.getConfigs();
		const branchInfos: Map<string, { remote?: string; metadata?: PullRequestMetadata }> = new Map();

		allConfigs.forEach(config => {
			const key = config.key;
			const matches = /^branch\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const branchName = matches[1];

				if (!branchInfos.has(branchName)) {
					branchInfos.set(branchName, {});
				}

				const value = branchInfos.get(branchName);
				if (matches[2] === 'remote') {
					value!['remote'] = config.value;
				}

				if (matches[2] === 'github-pr-owner-number') {
					const metadata = PullRequestGitHelper.parsePullRequestMetadata(config.value);
					value!['metadata'] = metadata;
				}

				branchInfos.set(branchName, value!);
			}
		});

		const actions: (vscode.QuickPickItem & { metadata: PullRequestMetadata; legacy?: boolean })[] = [];
		branchInfos.forEach((value, key) => {
			if (value.metadata) {
				const activePRUrl = this.activePullRequest && this.activePullRequest.base.repositoryCloneUrl;
				const matchesActiveBranch = activePRUrl
					? activePRUrl.owner === value.metadata.owner &&
					activePRUrl.repositoryName === value.metadata.repositoryName &&
					this.activePullRequest &&
					this.activePullRequest.number === value.metadata.prNumber
					: false;

				if (!matchesActiveBranch) {
					actions.push({
						label: `${key}`,
						description: `${value.metadata!.repositoryName}/${value.metadata!.owner} #${value.metadata.prNumber
							}`,
						picked: false,
						metadata: value.metadata!,
					});
				}
			}
		});

		const results = await Promise.all(
			actions.map(async action => {
				const metadata = action.metadata;
				const githubRepo = this._githubRepositories.find(
					repo =>
						repo.remote.owner.toLowerCase() === metadata!.owner.toLowerCase() &&
						repo.remote.repositoryName.toLowerCase() === metadata!.repositoryName.toLowerCase(),
				);

				if (!githubRepo) {
					return action;
				}

				const { remote, query, schema } = await githubRepo.ensure();
				try {
					const { data } = await query<PullRequestState>({
						query: schema.PullRequestState,
						variables: {
							owner: remote.owner,
							name: remote.repositoryName,
							number: metadata!.prNumber,
						},
					});

					action.legacy = data.repository.pullRequest.state !== 'OPEN';
				} catch { }

				return action;
			}),
		);

		results.forEach(result => {
			if (result.legacy) {
				result.picked = true;
			} else {
				result.description = vscode.l10n.t('{0} is still Open', result.description!);
			}
		});

		return results;
	}

	public async cleanupAfterPullRequest(branchName: string, pullRequest: PullRequestModel) {
		const defaults = await this.getPullRequestDefaults();
		if (branchName === defaults.base) {
			Logger.debug('Not cleaning up default branch.', FolderRepositoryManager.ID);
			return;
		}
		if (pullRequest.author.login === (await this.getCurrentUser()).login) {
			Logger.debug('Not cleaning up user\'s branch.', FolderRepositoryManager.ID);
			return;
		}
		const branch = await this.repository.getBranch(branchName);
		const remote = branch.upstream?.remote;
		try {
			Logger.debug(`Cleaning up branch ${branchName}`, FolderRepositoryManager.ID);
			await this.repository.deleteBranch(branchName);
		} catch (e) {
			// The branch probably had unpushed changes and cannot be deleted.
			return;
		}
		if (!remote) {
			return;
		}
		const remotes = await this.getDeleatableRemotes(undefined);
		if (remotes.has(remote) && remotes.get(remote)!.createdForPullRequest) {
			Logger.debug(`Cleaning up remote ${remote}`, FolderRepositoryManager.ID);
			this.repository.removeRemote(remote);
		}
	}

	private async getDeleatableRemotes(nonExistantBranches?: Set<string>) {
		const newConfigs = await this.repository.getConfigs();
		const remoteInfos: Map<
			string,
			{ branches: Set<string>; url?: string; createdForPullRequest?: boolean }
		> = new Map();

		newConfigs.forEach(config => {
			const key = config.key;
			let matches = /^branch\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const branchName = matches[1];

				if (matches[2] === 'remote') {
					const remoteName = config.value;

					if (!remoteInfos.has(remoteName)) {
						remoteInfos.set(remoteName, { branches: new Set() });
					}

					if (!nonExistantBranches?.has(branchName)) {
						const value = remoteInfos.get(remoteName);
						value!.branches.add(branchName);
					}
				}
			}

			matches = /^remote\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const remoteName = matches[1];

				if (!remoteInfos.has(remoteName)) {
					remoteInfos.set(remoteName, { branches: new Set() });
				}

				const value = remoteInfos.get(remoteName);

				if (matches[2] === 'github-pr-remote') {
					value!.createdForPullRequest = config.value === 'true';
				}

				if (matches[2] === 'url') {
					value!.url = config.value;
				}
			}
		});
		return remoteInfos;
	}

	private async getRemoteDeletionItems(nonExistantBranches: Set<string>) {
		// check if there are remotes that should be cleaned
		const remoteInfos = await this.getDeleatableRemotes(nonExistantBranches);
		const remoteItems: (vscode.QuickPickItem & { remote: string })[] = [];

		remoteInfos.forEach((value, key) => {
			if (value.branches.size === 0) {
				let description = value.createdForPullRequest ? '' : vscode.l10n.t('Not created by GitHub Pull Request extension');
				if (value.url) {
					description = description ? `${description} ${value.url}` : value.url;
				}

				remoteItems.push({
					label: key,
					description: description,
					picked: value.createdForPullRequest,
					remote: key,
				});
			}
		});

		return remoteItems;
	}

	async deleteLocalBranchesNRemotes() {
		return new Promise<void>(async resolve => {
			const quickPick = vscode.window.createQuickPick();
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			quickPick.placeholder = vscode.l10n.t('Choose local branches you want to delete permanently');
			quickPick.show();
			quickPick.busy = true;

			// Check local branches
			const results = await this.getBranchDeletionItems();
			const defaults = await this.getPullRequestDefaults();
			quickPick.items = results;
			quickPick.selectedItems = results.filter(result => {
				// Do not pick the default branch for the repo.
				return result.picked && !((result.label === defaults.base) && (result.metadata.owner === defaults.owner) && (result.metadata.repositoryName === defaults.repo));
			});
			quickPick.busy = false;

			let firstStep = true;
			quickPick.onDidAccept(async () => {
				quickPick.busy = true;

				if (firstStep) {
					const picks = quickPick.selectedItems;
					const nonExistantBranches = new Set<string>();
					if (picks.length) {
						try {
							await Promise.all(
								picks.map(async pick => {
									try {
										await this.repository.deleteBranch(pick.label, true);
									} catch (e) {
										if ((typeof e.stderr === 'string') && (e.stderr as string).includes('not found')) {
											// TODO: The git extension API doesn't support removing configs
											// If that support is added we should remove the config as it is no longer useful.
											nonExistantBranches.add(pick.label);
										} else {
											throw e;
										}
									}
								}));
						} catch (e) {
							quickPick.hide();
							vscode.window.showErrorMessage(vscode.l10n.t('Deleting branches failed: {0} {1}', e.message, e.stderr));
						}
					}

					firstStep = false;
					const remoteItems = await this.getRemoteDeletionItems(nonExistantBranches);

					if (remoteItems && remoteItems.length) {
						quickPick.placeholder = vscode.l10n.t('Choose remotes you want to delete permanently');
						quickPick.items = remoteItems;
						quickPick.selectedItems = remoteItems.filter(item => item.picked);
					} else {
						quickPick.hide();
					}
				} else {
					// delete remotes
					const picks = quickPick.selectedItems;
					if (picks.length) {
						await Promise.all(
							picks.map(async pick => {
								await this.repository.removeRemote(pick.label);
							}),
						);
					}
					quickPick.hide();
				}
				quickPick.busy = false;
			});

			quickPick.onDidHide(() => {
				resolve();
			});
		});
	}

	async getPullRequestRepositoryDefaultBranch(issue: IssueModel): Promise<string> {
		const branch = await issue.githubRepository.getDefaultBranch();
		return branch;
	}

	async getPullRequestRepositoryAccessAndMergeMethods(
		pullRequest: PullRequestModel,
	): Promise<RepoAccessAndMergeMethods> {
		const mergeOptions = await pullRequest.githubRepository.getRepoAccessAndMergeMethods();
		return mergeOptions;
	}

	async fulfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		try {
			if (!pullRequest.isResolved()) {
				return;
			}

			Logger.debug(`Fulfill pull request missing info - start`, FolderRepositoryManager.ID);
			const githubRepository = pullRequest.githubRepository;
			const { octokit, remote } = await githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.call(octokit.api.pulls.get, {
					owner: remote.owner,
					repo: remote.repositoryName,
					pull_number: pullRequest.number,
				});
				pullRequest.update(convertRESTPullRequestToRawPullRequest(data, githubRepository));
			}

			if (!pullRequest.mergeBase) {
				const { data } = await octokit.call(octokit.api.repos.compareCommits, {
					repo: remote.repositoryName,
					owner: remote.owner,
					base: `${pullRequest.base.repositoryCloneUrl.owner}:${pullRequest.base.ref}`,
					head: `${pullRequest.head.repositoryCloneUrl.owner}:${pullRequest.head.ref}`,
				});

				pullRequest.mergeBase = data.merge_base_commit.sha;
			}
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Fetching Pull Request merge base failed: {0}', formatError(e)));
		}
		Logger.debug(`Fulfill pull request missing info - done`, FolderRepositoryManager.ID);
	}

	//#region Git related APIs

	private async resolveItem(owner: string, repositoryName: string): Promise<GitHubRepository | undefined> {
		let githubRepo = this._githubRepositories.find(repo => {
			const ret =
				repo.remote.owner.toLowerCase() === owner.toLowerCase() &&
				repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase();
			return ret;
		});

		if (!githubRepo) {
			// try to create the repository
			githubRepo = await this.createGitHubRepositoryFromOwnerName(owner, repositoryName);
		}
		return githubRepo;
	}

	async resolvePullRequest(
		owner: string,
		repositoryName: string,
		pullRequestNumber: number,
	): Promise<PullRequestModel | undefined> {
		const githubRepo = await this.resolveItem(owner, repositoryName);
		if (githubRepo) {
			const pr = await githubRepo.getPullRequest(pullRequestNumber);
			if (pr) {
				if (await githubRepo.hasBranch(pr.base.name)) {
					return pr;
				}
			}
		}
		return undefined;
	}

	async resolveIssue(
		owner: string,
		repositoryName: string,
		pullRequestNumber: number,
		withComments: boolean = false,
	): Promise<IssueModel | undefined> {
		const githubRepo = await this.resolveItem(owner, repositoryName);
		if (githubRepo) {
			return githubRepo.getIssue(pullRequestNumber, withComments);
		}
		return undefined;
	}

	async resolveUser(owner: string, repositoryName: string, login: string): Promise<User | undefined> {
		Logger.debug(`Fetch user ${login}`, FolderRepositoryManager.ID);
		const githubRepository = await this.createGitHubRepositoryFromOwnerName(owner, repositoryName);
		const { query, schema } = await githubRepository.ensure();

		try {
			const { data } = await query<UserResponse>({
				query: schema.GetUser,
				variables: {
					login,
				},
			});
			return parseGraphQLUser(data, githubRepository);
		} catch (e) {
			// Ignore cases where the user doesn't exist
			if (!(e.message as (string | undefined))?.startsWith('GraphQL error: Could not resolve to a User with the login of')) {
				Logger.warn(e.message);
			}
		}
		return undefined;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this.repository || !this.repository.state.HEAD || !this.repository.state.HEAD.name) {
			return null;
		}

		const matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(
			this.repository,
			this.repository.state.HEAD.name,
		);
		return matchingPullRequestMetadata;
	}

	async getMatchingPullRequestMetadataFromGitHub(remoteName?: string, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		if (!remoteName || !upstreamBranchName) {
			return null;
		}

		const headGitHubRepo = this.gitHubRepositories.find(
			repo => repo.remote.remoteName === remoteName,
		);
		const headRepoMetadata = await headGitHubRepo?.getMetadata();
		if (!headRepoMetadata?.owner) {
			return null;
		}

		const parentRepos = this.gitHubRepositories.filter(repo => {
			if (headRepoMetadata.fork) {
				return repo.remote.owner === headRepoMetadata.parent?.owner?.login && repo.remote.repositoryName === headRepoMetadata.parent.name;
			} else {
				return repo.remote.owner === headRepoMetadata.owner?.login && repo.remote.repositoryName === headRepoMetadata.name;
			}
		});

		// Search through each github repo to see if it has a PR with this head branch.
		for (const repo of parentRepos) {
			const matchingPullRequest = await repo.getPullRequestForBranch(upstreamBranchName, headRepoMetadata.owner.login);
			if (matchingPullRequest) {
				return {
					owner: repo.remote.owner,
					repositoryName: repo.remote.repositoryName,
					prNumber: matchingPullRequest.number,
					model: matchingPullRequest,
				};
			}
		}
		return null;
	}

	async checkoutExistingPullRequestBranch(pullRequest: PullRequestModel, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
		return await PullRequestGitHelper.checkoutExistingPullRequestBranch(this.repository, pullRequest, progress);
	}

	async getBranchNameForPullRequest(pullRequest: PullRequestModel) {
		return await PullRequestGitHelper.getBranchNRemoteForPullRequest(this.repository, pullRequest);
	}

	async fetchAndCheckout(pullRequest: PullRequestModel, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, this._allGitHubRemotes, pullRequest, progress);
	}

	async checkout(branchName: string): Promise<void> {
		return this.repository.checkout(branchName);
	}

	async fetchById(githubRepo: GitHubRepository, id: number): Promise<PullRequestModel | undefined> {
		const pullRequest = await githubRepo.getPullRequest(id);
		if (pullRequest) {
			return pullRequest;
		} else {
			vscode.window.showErrorMessage(vscode.l10n.t('Pull request number {0} does not exist in {1}', id, `${githubRepo.remote.owner}/${githubRepo.remote.repositoryName}`), { modal: true });
		}
	}

	public async checkoutDefaultBranch(branch: string): Promise<void> {
		let branchObj: Branch | undefined;
		try {
			branchObj = await this.repository.getBranch(branch);

			const currentBranch = this.repository.state.HEAD?.name;
			if (currentBranch === branchObj.name) {
				const chooseABranch = vscode.l10n.t('Choose a Branch');
				vscode.window.showInformationMessage(vscode.l10n.t('The default branch is already checked out.'), chooseABranch).then(choice => {
					if (choice === chooseABranch) {
						return git.checkout();
					}
				});
				return;
			}

			// respect the git setting to fetch before checkout
			if (vscode.workspace.getConfiguration(GIT).get<boolean>(PULL_BEFORE_CHECKOUT, false) && branchObj.upstream) {
				await this.repository.fetch({ remote: branchObj.upstream.remote, ref: `${branchObj.upstream.name}:${branchObj.name}` });
			}

			if (branchObj.upstream && branch === branchObj.upstream.name) {
				await this.repository.checkout(branch);
			} else {
				await git.checkout();
			}

			const fileClose: Thenable<boolean>[] = [];
			// Close the PR description and any open review scheme files.
			for (const tabGroup of vscode.window.tabGroups.all) {
				for (const tab of tabGroup.tabs) {
					let uri: vscode.Uri | string | undefined;
					if (tab.input instanceof vscode.TabInputText) {
						uri = tab.input.uri;
					} else if (tab.input instanceof vscode.TabInputTextDiff) {
						uri = tab.input.original;
					} else if (tab.input instanceof vscode.TabInputWebview) {
						uri = tab.input.viewType;
					}
					if ((uri instanceof vscode.Uri && uri.scheme === Schemes.Review) || (typeof uri === 'string' && uri.endsWith(PULL_REQUEST_OVERVIEW_VIEW_TYPE))) {
						fileClose.push(vscode.window.tabGroups.close(tab));
					}
				}
			}
			await Promise.all(fileClose);
		} catch (e) {
			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches'),
					);
					return;
				}
			}
			Logger.error(`Exiting failed: ${e}. Target branch ${branch} used to find branch ${branchObj?.name ?? 'unknown'} with upstream ${branchObj?.upstream ?? 'unknown'}.`);
			vscode.window.showErrorMessage(`Exiting failed: ${e}`);
		}
	}

	private async pullBranchConfiguration(): Promise<'never' | 'prompt' | 'always'> {
		const neverShowPullNotification = this.context.globalState.get<boolean>(NEVER_SHOW_PULL_NOTIFICATION, false);
		if (neverShowPullNotification) {
			this.context.globalState.update(NEVER_SHOW_PULL_NOTIFICATION, false);
			await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(PULL_BRANCH, 'never', vscode.ConfigurationTarget.Global);
		}
		return vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'never' | 'prompt' | 'always'>(PULL_BRANCH, 'prompt');
	}

	private async pullBranch(branch: Branch) {
		if (this._repository.state.HEAD?.name === branch.name) {
			await this._repository.pull();
		}
	}

	private async promptPullBrach(pr: PullRequestModel, branch: Branch, autoStashSetting?: boolean) {
		if (!this._updateMessageShown || autoStashSetting) {
			this._updateMessageShown = true;
			const pull = vscode.l10n.t('Pull');
			const always = vscode.l10n.t('Always Pull');
			const never = vscode.l10n.t('Never Show Again');
			const options = [pull];
			if (!autoStashSetting) {
				options.push(always, never);
			}
			const result = await vscode.window.showInformationMessage(
				vscode.l10n.t('There are updates available for pull request {0}.', `${pr.number}: ${pr.title}`),
				{},
				...options
			);

			if (result === pull) {
				await this.pullBranch(branch);
				this._updateMessageShown = false;
			} else if (never) {
				await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(PULL_BRANCH, 'never', vscode.ConfigurationTarget.Global);
			} else if (always) {
				await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(PULL_BRANCH, 'always', vscode.ConfigurationTarget.Global);
				await this.pullBranch(branch);
			}
		}
	}

	private _updateMessageShown: boolean = false;
	public async checkBranchUpToDate(pr: PullRequestModel & IResolvedPullRequestModel, shouldFetch: boolean): Promise<void> {
		if (this.activePullRequest?.id !== pr.id) {
			return;
		}
		const branch = this._repository.state.HEAD;
		if (branch) {
			const remote = branch.upstream ? branch.upstream.remote : null;
			const remoteBranch = branch.upstream ? branch.upstream.name : branch.name;
			if (remote) {
				try {
					if (shouldFetch) {
						await this._repository.fetch(remote, remoteBranch);
					}
				} catch (e) {
					if (e.stderr) {
						if ((e.stderr as string).startsWith('fatal: couldn\'t find remote ref')) {
							// We've managed to check out the PR, but the remote has been deleted. This is fine, but we can't fetch now.
						} else {
							vscode.window.showErrorMessage(vscode.l10n.t('An error occurred when fetching the repository: {0}', e.stderr));
						}
					}
					Logger.error(`Error when fetching: ${e.stderr ?? e}`, FolderRepositoryManager.ID);
				}
				const pullBranchConfiguration = await this.pullBranchConfiguration();
				if (branch.behind !== undefined && branch.behind > 0) {
					switch (pullBranchConfiguration) {
						case 'always': {
							const autoStash = vscode.workspace.getConfiguration(GIT).get<boolean>(AUTO_STASH, false);
							if (autoStash) {
								return this.promptPullBrach(pr, branch, autoStash);
							} else {
								return this.pullBranch(branch);
							}
						}
						case 'prompt': {
							return this.promptPullBrach(pr, branch);
						}
						case 'never': return;
					}
				}

			}
		}
	}

	private findExistingGitHubRepository(remote: { owner: string, repositoryName: string, remoteName?: string }): GitHubRepository | undefined {
		return this._githubRepositories.find(
			r =>
				(r.remote.owner.toLowerCase() === remote.owner.toLowerCase())
				&& (r.remote.repositoryName.toLowerCase() === remote.repositoryName.toLowerCase())
				&& (!remote.remoteName || (r.remote.remoteName === remote.remoteName)),
		);
	}

	private async createAndAddGitHubRepository(remote: Remote, credentialStore: CredentialStore, silent?: boolean) {
		const repo = new GitHubRepository(GitHubRemote.remoteAsGitHub(remote, await this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)), this.repository.rootUri, credentialStore, this.telemetry, silent);
		this._githubRepositories.push(repo);
		return repo;
	}

	private _createGitHubRepositoryBulkhead = bulkhead(1, 300);
	async createGitHubRepository(remote: Remote, credentialStore: CredentialStore, silent?: boolean, ignoreRemoteName: boolean = false): Promise<GitHubRepository> {
		// Use a bulkhead/semaphore to ensure that we don't create multiple GitHubRepositories for the same remote at the same time.
		return this._createGitHubRepositoryBulkhead.execute(() => {
			return this.findExistingGitHubRepository({ owner: remote.owner, repositoryName: remote.repositoryName, remoteName: ignoreRemoteName ? undefined : remote.remoteName }) ??
				this.createAndAddGitHubRepository(remote, credentialStore, silent);
		});
	}

	async createGitHubRepositoryFromOwnerName(owner: string, repositoryName: string): Promise<GitHubRepository> {
		const existing = this.findExistingGitHubRepository({ owner, repositoryName });
		if (existing) {
			return existing;
		}
		const gitRemotes = parseRepositoryRemotes(this.repository);
		const gitRemote = gitRemotes.find(r => r.owner === owner && r.repositoryName === repositoryName);
		const uri = gitRemote?.url ?? `https://github.com/${owner}/${repositoryName}`;
		return this.createAndAddGitHubRepository(new Remote(gitRemote?.remoteName ?? repositoryName, uri, new Protocol(uri)), this._credentialStore);
	}

	async findUpstreamForItem(item: {
		remote: Remote;
		githubRepository: GitHubRepository;
	}): Promise<{ needsFork: boolean; upstream?: GitHubRepository; remote?: Remote }> {
		let upstream: GitHubRepository | undefined;
		let existingForkRemote: Remote | undefined;
		for (const githubRepo of this.gitHubRepositories) {
			if (
				!upstream &&
				githubRepo.remote.owner === item.remote.owner &&
				githubRepo.remote.repositoryName === item.remote.repositoryName
			) {
				upstream = githubRepo;
				continue;
			}
			const forkDetails = await githubRepo.getRepositoryForkDetails();
			if (
				forkDetails &&
				forkDetails.isFork &&
				forkDetails.parent.owner.login === item.remote.owner &&
				forkDetails.parent.name === item.remote.repositoryName
			) {
				const foundforkPermission = await githubRepo.getViewerPermission();
				if (
					foundforkPermission === ViewerPermission.Admin ||
					foundforkPermission === ViewerPermission.Maintain ||
					foundforkPermission === ViewerPermission.Write
				) {
					existingForkRemote = githubRepo.remote;
					break;
				}
			}
		}
		let needsFork = false;
		if (upstream && !existingForkRemote) {
			const permission = await item.githubRepository.getViewerPermission();
			if (
				permission === ViewerPermission.Read ||
				permission === ViewerPermission.Triage ||
				permission === ViewerPermission.Unknown
			) {
				needsFork = true;
			}
		}
		return { needsFork, upstream, remote: existingForkRemote };
	}

	async forkWithProgress(
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		githubRepository: GitHubRepository,
		repoString: string,
		matchingRepo: Repository,
	): Promise<string | undefined> {
		progress.report({ message: vscode.l10n.t('Forking {0}...', repoString) });
		const result = await githubRepository.fork();
		progress.report({ increment: 50 });
		if (!result) {
			vscode.window.showErrorMessage(
				vscode.l10n.t('Unable to create a fork of {0}. Check that your GitHub credentials are correct.', repoString),
			);
			return;
		}

		const workingRemoteName: string =
			matchingRepo.state.remotes.length > 1 ? 'origin' : matchingRepo.state.remotes[0].name;
		progress.report({ message: vscode.l10n.t('Adding remotes. This may take a few moments.') });
		await matchingRepo.renameRemote(workingRemoteName, 'upstream');
		await matchingRepo.addRemote(workingRemoteName, result);
		// Now the extension is responding to all the git changes.
		await new Promise<void>(resolve => {
			if (this.gitHubRepositories.length === 0) {
				const disposable = this.onDidChangeRepositories(() => {
					if (this.gitHubRepositories.length > 0) {
						disposable.dispose();
						resolve();
					}
				});
			} else {
				resolve();
			}
		});
		progress.report({ increment: 50 });
		return workingRemoteName;
	}

	async doFork(
		githubRepository: GitHubRepository,
		repoString: string,
		matchingRepo: Repository,
	): Promise<string | undefined> {
		return vscode.window.withProgress<string | undefined>(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating Fork') },
			async progress => {
				try {
					return this.forkWithProgress(progress, githubRepository, repoString, matchingRepo);
				} catch (e) {
					vscode.window.showErrorMessage(`Creating fork failed: ${e}`);
				}
				return undefined;
			},
		);
	}

	async tryOfferToFork(githubRepository: GitHubRepository): Promise<string | false | undefined> {
		const repoString = `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`;

		const fork = vscode.l10n.t('Fork');
		const dontFork = vscode.l10n.t('Don\'t Fork');
		const response = await vscode.window.showInformationMessage(
			vscode.l10n.t('You don\'t have permission to push to {0}. Do you want to fork {0}? This will modify your git remotes to set \`origin\` to the fork, and \`upstream\` to {0}.', repoString),
			{ modal: true },
			fork,
			dontFork,
		);
		switch (response) {
			case fork: {
				return this.doFork(githubRepository, repoString, this.repository);
			}
			case dontFork:
				return false;
			default:
				return undefined;
		}
	}

	dispose() {
		this._subs.forEach(sub => sub.dispose());
		this._onDidDispose.fire();
	}
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

const ownedByMe: Predicate<GitHubRepository> = repo => {
	const { currentUser = null } = repo.octokit as any;
	return currentUser && repo.remote.owner === currentUser.login;
};

export const byRemoteName = (name: string): Predicate<GitHubRepository> => ({ remote: { remoteName } }) =>
	remoteName === name;

export const titleAndBodyFrom = (message: string): { title: string; body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1 ? message : message.substr(0, idxLineBreak),

		body: idxLineBreak === -1 ? '' : message.slice(idxLineBreak + 1).trim(),
	};
};
