/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import { bulkhead } from 'cockatiel';
import * as vscode from 'vscode';
import type { Branch, Commit, Repository, UpstreamRef } from '../api/api';
import { GitApiImpl, GitErrorCodes } from '../api/api1';
import { GitHubManager } from '../authentication/githubServer';
import { AuthProvider, GitHubServerType } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import { InMemFileChange, SlimFileChange } from '../common/file';
import { findLocalRepoRemoteFromGitHubRef } from '../common/githubRef';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { Protocol, ProtocolType } from '../common/protocol';
import { GitHubRemote, parseRemote, parseRepositoryRemotes, Remote } from '../common/remote';
import {
	ALLOW_FETCH,
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
import { EventType, TimelineEvent } from '../common/timelineEvent';
import { Schemes } from '../common/uri';
import { batchPromiseAll, compareIgnoreCase, formatError, Predicate } from '../common/utils';
import { PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { LAST_USED_EMAIL, NEVER_SHOW_PULL_NOTIFICATION, REPO_KEYS, ReposState } from '../extensionState';
import { git } from '../gitProviders/gitCommands';
import { CreatePullRequestHelper } from '../view/createPullRequestHelper';
import { OctokitCommon } from './common';
import { ConflictModel } from './conflictGuide';
import { ConflictResolutionCoordinator } from './conflictResolutionCoordinator';
import { Conflict, ConflictResolutionModel } from './conflictResolutionModel';
import { CredentialStore } from './credentials';
import { GitHubRepository, GraphQLError, GraphQLErrorType, IMetadata, ItemsData, PULL_REQUEST_PAGE_SIZE, PullRequestData, TeamReviewerRefreshKind, ViewerPermission } from './githubRepository';
import { MergeMethod as GraphQLMergeMethod, MergePullRequestInput, MergePullRequestResponse, PullRequestResponse, PullRequestState, UserResponse } from './graphql';
import { IAccount, ILabel, IMilestone, IProject, IPullRequestsPagingOptions, Issue, ITeam, MergeMethod, PRType, PullRequestMergeability, RepoAccessAndMergeMethods, User } from './interface';
import { IssueModel } from './issueModel';
import { PullRequestGitHelper, PullRequestMetadata } from './pullRequestGitHelper';
import { IResolvedPullRequestModel, PullRequestModel } from './pullRequestModel';
import {
	convertRESTIssueToRawPullRequest,
	convertRESTPullRequestToRawPullRequest,
	getOverrideBranch,
	getPRFetchQuery,
	loginComparator,
	parseCombinedTimelineEvents,
	parseGraphQLPullRequest,
	parseGraphQLUser,
	teamComparator,
	variableSubstitution,
} from './utils';

async function createConflictResolutionModel(pullRequest: PullRequestModel): Promise<ConflictResolutionModel | undefined> {
	const head = pullRequest.head;
	if (!head) {
		throw new Error('No head found for pull request');
	}
	const baseCommitSha = await pullRequest.getLatestBaseCommitSha();
	const prBaseOwner = pullRequest.base.owner;
	const prHeadOwner = head.owner;
	const prHeadRef = head.ref;
	const repositoryName = (await pullRequest.githubRepository.ensure()).remote.repositoryName;
	const potentialMergeConflicts: Conflict[] = [];
	if (pullRequest.item.mergeable === PullRequestMergeability.Conflict) {
		const mergeBaseIntoPrCompareData = await pullRequest.compareBaseBranchForMerge(prHeadOwner, prHeadRef, prBaseOwner, baseCommitSha);
		if ((pullRequest.item.mergeable === PullRequestMergeability.Conflict) && (mergeBaseIntoPrCompareData.length >= 300)) {
			// API limitation: it only returns the first 300 files
			return undefined;
		}

		const previousFilenames: Map<string, SlimFileChange | InMemFileChange> = new Map();
		// We must also check all the previous file names of the files in the PR. Assemble a map with this info
		for (const fileChange of pullRequest.fileChanges.values()) {
			if (fileChange.previousFileName) {
				previousFilenames.set(fileChange.previousFileName, fileChange);
			}
		}
		const knownConflicts = new Set<string>(pullRequest.conflicts);
		for (const mergeFile of mergeBaseIntoPrCompareData) {
			const fileChange = pullRequest.fileChanges.get(mergeFile.filename) ?? previousFilenames.get(mergeFile.filename);
			if (fileChange && (knownConflicts.size === 0 || knownConflicts.has(fileChange.fileName))) {
				const prHeadFilePath = fileChange.fileName;
				let contentsConflict = false;
				let filePathConflict = false;
				let modeConflict = false;
				if (mergeFile.status === 'modified') {
					contentsConflict = true;
				}
				if (mergeFile.previous_filename || fileChange.previousFileName) {
					filePathConflict = true;
				}
				potentialMergeConflicts.push({ prHeadFilePath, contentsConflict, filePathConflict, modeConflict });
			}
		}
	}
	return new ConflictResolutionModel(potentialMergeConflicts, repositoryName, prBaseOwner, baseCommitSha, prHeadOwner, prHeadRef,
		pullRequest.base.ref, pullRequest.mergeBase!);
}

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean | null;
}

export interface ItemsResponseResult<T> {
	items: T[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
	totalCount?: number;
}

export class NoGitHubReposError extends Error {
	constructor(public readonly repository: Repository) {
		super();
	}

	override get message() {
		return vscode.l10n.t('{0} has no GitHub remotes', this.repository.rootUri.toString());
	}
}

export class DetachedHeadError extends Error {
	constructor(public readonly repository: Repository) {
		super();
	}

	override get message() {
		return vscode.l10n.t('{0} has a detached HEAD (create a branch first', this.repository.rootUri.toString());
	}
}

export class BadUpstreamError extends Error {
	constructor(public readonly branchName: string, public readonly upstreamRef: UpstreamRef, public readonly problem: string) {
		super();
	}

	override get message() {
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

enum PagedDataType {
	PullRequest,
	IssueSearch,
}

const CACHED_TEMPLATE_BODY = 'templateBody';

export class FolderRepositoryManager extends Disposable {
	static ID = 'FolderRepositoryManager';

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

	private _onDidMergePullRequest = this._register(new vscode.EventEmitter<void>());
	readonly onDidMergePullRequest = this._onDidMergePullRequest.event;

	private _onDidChangeActivePullRequest = this._register(new vscode.EventEmitter<{ new: number | undefined, old: number | undefined }>());
	readonly onDidChangeActivePullRequest: vscode.Event<{ new: number | undefined, old: number | undefined }> = this._onDidChangeActivePullRequest.event;
	private _onDidChangeActiveIssue = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeActiveIssue: vscode.Event<void> = this._onDidChangeActiveIssue.event;

	private _onDidLoadRepositories = this._register(new vscode.EventEmitter<ReposManagerState>());
	readonly onDidLoadRepositories: vscode.Event<ReposManagerState> = this._onDidLoadRepositories.event;

	private _onDidChangeRepositories = this._register(new vscode.EventEmitter<{ added: boolean }>());
	readonly onDidChangeRepositories: vscode.Event<{ added: boolean }> = this._onDidChangeRepositories.event;

	private _onDidChangeAssignableUsers = this._register(new vscode.EventEmitter<IAccount[]>());
	readonly onDidChangeAssignableUsers: vscode.Event<IAccount[]> = this._onDidChangeAssignableUsers.event;

	private _onDidChangeGithubRepositories = this._register(new vscode.EventEmitter<GitHubRepository[]>());
	readonly onDidChangeGithubRepositories: vscode.Event<GitHubRepository[]> = this._onDidChangeGithubRepositories.event;

	private _onDidDispose = this._register(new vscode.EventEmitter<void>());
	readonly onDidDispose: vscode.Event<void> = this._onDidDispose.event;

	private _sessionIgnoredRemoteNames: Set<string> = new Set();

	constructor(
		private readonly _id: number,
		public readonly context: vscode.ExtensionContext,
		private _repository: Repository,
		public readonly telemetry: ITelemetry,
		private readonly _git: GitApiImpl,
		private readonly _credentialStore: CredentialStore,
		public readonly createPullRequestHelper: CreatePullRequestHelper
	) {
		super();
		this._githubRepositories = [];
		this._githubManager = new GitHubManager();

		this._register(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${REMOTES}`)) {
					await this.updateRepositories();
				}
			}),
		);

		this._register(_credentialStore.onDidInitialize(() => this.updateRepositories()));

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

	private get id(): string {
		return `${FolderRepositoryManager.ID}+${this._id}`;
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
			Logger.error(`Resolving GitHub remotes failed: ${e}`, this.id);
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
			Logger.error(`Resolving GitHub remotes failed: ${e}`, this.id);
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
			Logger.error(`Unable to read remotes setting`, this.id);
			return Promise.resolve([]);
		}

		const missingRemotes = remotesSetting.filter(remote => {
			return !allGitHubRemotes.some(repo => repo.remoteName === remote);
		});

		if (missingRemotes.length === remotesSetting.length) {
			Logger.warn(`No remotes found. The following remotes are missing: ${missingRemotes.join(', ')}`);
		} else {
			Logger.debug(`Not all remotes found. The following remotes are missing: ${missingRemotes.join(', ')}`, this.id);
		}

		Logger.debug(`Displaying configured remotes: ${remotesSetting.join(', ')}`, this.id);

		return remotesSetting
			.map(remote => allGitHubRemotes.find(repo => repo.remoteName === remote))
			.filter((repo: GitHubRemote | undefined): repo is GitHubRemote => !!repo && !this._sessionIgnoredRemoteNames.has(repo.remoteName));
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
		if (pullRequest === this._activePullRequest) {
			return;
		}
		const oldNumber = this._activePullRequest?.number;
		if (this._activePullRequest) {
			this._activePullRequest.isActive = false;
		}

		if (pullRequest) {
			pullRequest.isActive = true;
			pullRequest.githubRepository.commentsHandler?.unregisterCommentController(pullRequest.number);
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
			Logger.appendLine(`Found GitHub remote for folder ${this.repository.rootUri.fsPath}`, this.id);
		} else {
			Logger.appendLine(`No GitHub remotes found for folder ${this.repository.rootUri.fsPath}`, this.id);
		}

		return activeRemotes;
	}

	private _updatingRepositories: Promise<boolean> | undefined;
	async updateRepositories(silent: boolean = false): Promise<boolean> {
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

	private async doUpdateRepositories(silent: boolean): Promise<boolean> {
		if (this._git.state === 'uninitialized') {
			Logger.appendLine('Cannot updates repositories as git is uninitialized', this.id);

			return false;
		}

		const activeRemotes = await this.getActiveRemotes();
		const isAuthenticated = this.checkForAuthMatch(activeRemotes);
		if (this.credentialStore.isAnyAuthenticated() && (activeRemotes.length === 0)) {
			const areAllNeverGitHub = (await this.computeAllUnknownRemotes()).every(remote => GitHubManager.isNeverGitHub(vscode.Uri.parse(remote.normalizedHost).authority));
			if (areAllNeverGitHub) {
				this._onDidLoadRepositories.fire(ReposManagerState.RepositoriesLoaded);
				return true;
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

		const cleanUpMissingSaml = async (missingSaml: GitHubRepository[]) => {
			for (const missing of missingSaml) {
				this._sessionIgnoredRemoteNames.add(missing.remote.remoteName);
				this.removeGitHubRepository(missing.remote);
				const index = repositories.indexOf(missing);
				if (index > -1) {
					repositories.splice(index, 1);
				}
			}
		};

		return Promise.all(resolveRemotePromises).then(async (remoteResults: boolean[]) => {
			const missingSaml: GitHubRepository[] = [];
			for (let i = 0; i < remoteResults.length; i++) {
				if (!remoteResults[i]) {
					missingSaml.push(repositories[i]);
				}
			}
			if (missingSaml.length > 0) {
				const result = await this._credentialStore.showSamlMessageAndAuth(missingSaml.map(repo => repo.remote.owner));
				// Make a test call to see if the user has SAML enabled.
				const samlTest = result.canceled ? [] : await Promise.all(missingSaml.map(repo => repo.resolveRemote()));
				const stillMissing = result.canceled ? missingSaml : samlTest.map((result, index) => !result ? missingSaml[index] : undefined).filter((repo): repo is GitHubRepository => !!repo);
				// Make a test call to see if the user has SAML enabled.
				if (stillMissing.length > 0) {
					if (stillMissing.length === repositories.length) {
						await vscode.window.showErrorMessage(vscode.l10n.t('SAML access was not provided. GitHub Pull Requests will not work.'), { modal: true });
						this.dispose();
						return true;
					}
					await vscode.window.showErrorMessage(vscode.l10n.t('SAML access was not provided. Some GitHub repositories will not be available.'), { modal: true });
					cleanUpMissingSaml(stillMissing);
				}
			}

			this._githubRepositories = repositories;
			oldRepositories.filter(old => this._githubRepositories.indexOf(old) < 0).forEach(repo => repo.dispose());

			const repositoriesAdded =
				oldRepositories.length !== this._githubRepositories.length ?
					this.gitHubRepositories.filter(repo =>
						!oldRepositories.some(oldRepo => oldRepo.remote.equals(repo.remote)),
					) : [];

			if (repositoriesAdded.length > 0) {
				this._onDidChangeGithubRepositories.fire(this._githubRepositories);
			}

			if (this._githubRepositories.length && repositoriesAdded.length > 0) {
				if (await this.checkIfMissingUpstream()) {
					this.updateRepositories(silent);
					return true;
				}
			}

			if (this.activePullRequest) {
				this.getMentionableUsers(repositoriesAdded.length > 0);
			}

			this.getAssignableUsers(repositoriesAdded.length > 0);
			if (isAuthenticated && activeRemotes.length) {
				this._onDidLoadRepositories.fire(ReposManagerState.RepositoriesLoaded);
			} else if (!isAuthenticated) {
				this._onDidLoadRepositories.fire(ReposManagerState.NeedsAuthentication);
			}
			if (!silent) {
				this._onDidChangeRepositories.fire({ added: repositoriesAdded.length > 0 });
			}
			return true;
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
						(compareIgnoreCase(repo.remote.owner, parentUrl.owner) === 0) &&
						(compareIgnoreCase(repo.remote.repositoryName, parentUrl.repositoryName) === 0),
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
			Logger.appendLine(`Missing upstream check failed: ${e}`, this.id);
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

	private async getCachedFromGlobalState<T>(userKind: 'assignableUsers' | 'teamReviewers' | 'mentionableUsers' | 'orgProjects'): Promise<{ [key: string]: T[] } | undefined> {
		Logger.appendLine(`Trying to use globalState for ${userKind}.`, this.id);

		const usersCacheLocation = vscode.Uri.joinPath(this.context.globalStorageUri, userKind);
		let usersCacheExists;
		try {
			usersCacheExists = await vscode.workspace.fs.stat(usersCacheLocation);
		} catch (e) {
			// file doesn't exit
		}
		if (!usersCacheExists) {
			Logger.appendLine(`GlobalState does not exist for ${userKind}.`, this.id);
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
					Logger.error(`Error parsing ${userKind} cache for ${repo.remote.remoteName}.`, this.id);
				}
				// file doesn't exist
			}
			if (repoSpecificCache && repoSpecificCache.toString()) {
				cache[repo.remote.remoteName] = cacheAsJson ?? [];
				return true;
			}
		}))).every(value => value);
		if (hasAllRepos) {
			Logger.appendLine(`Using globalState ${userKind} for ${Object.keys(cache).length}.`, this.id);
			return cache;
		}

		Logger.appendLine(`No globalState for ${userKind}.`, this.id);
		return undefined;
	}

	private async saveInGlobalState<T>(userKind: 'assignableUsers' | 'teamReviewers' | 'mentionableUsers' | 'orgProjects', cache: { [key: string]: T[] }): Promise<void> {
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
				this.saveInGlobalState('mentionableUsers', cache)
					.then(() => resolve(cache));
			});
		});
	}

	async getMentionableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._mentionableUsers;
		}

		if (this._mentionableUsers) {
			Logger.appendLine('Using in-memory cached mentionable users.', this.id);
			return this._mentionableUsers;
		}

		const globalStateMentionableUsers = await this.getCachedFromGlobalState<IAccount>('mentionableUsers');

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
			Logger.appendLine('Using in-memory cached assignable users.', this.id);
			return this._assignableUsers;
		}

		const globalStateAssignableUsers = await this.getCachedFromGlobalState<IAccount>('assignableUsers');

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
					this.saveInGlobalState('assignableUsers', cache);
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
			Logger.appendLine('Using in-memory cached team reviewers.', this.id);
			return this._teamReviewers;
		}

		const globalStateTeamReviewers = (refreshKind === TeamReviewerRefreshKind.Force) ? undefined : await this.getCachedFromGlobalState<ITeam>('teamReviewers');
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
				this.saveInGlobalState('teamReviewers', cache);
				resolve(cache);
			}));
		}

		return this._fetchTeamReviewersPromise;
	}

	private createFetchOrgProjectsPromise(): Promise<{ [key: string]: IProject[] }> {
		const cache: { [key: string]: IProject[] } = {};
		return new Promise<{ [key: string]: IProject[] }>(async resolve => {
			// Keep track of the org teams we have already gotten so we don't make duplicate calls
			const orgProjects: Map<string, IProject[]> = new Map();
			// Go through one github repo at a time so that we don't make overlapping auth calls
			for (const githubRepository of this._githubRepositories) {
				if (!orgProjects.has(githubRepository.remote.owner)) {
					try {
						const data = await githubRepository.getOrgProjects();
						orgProjects.set(githubRepository.remote.owner, data);
					} catch (e) {
						break;
					}
				}
				cache[githubRepository.remote.remoteName] = orgProjects.get(githubRepository.remote.owner) ?? [];
			}

			await this.saveInGlobalState('orgProjects', cache);
			resolve(cache);
		});
	}

	async getOrgProjects(clearCache?: boolean): Promise<{ [key: string]: IProject[] }> {
		if (clearCache) {
			return this.createFetchOrgProjectsPromise();
		}

		const globalStateProjects = await this.getCachedFromGlobalState<IProject>('orgProjects');
		return globalStateProjects ?? this.createFetchOrgProjectsPromise();
	}

	async getAllProjects(githubRepository: GitHubRepository, clearOrgCache?: boolean): Promise<IProject[]> {
		const isInOrganization = !!(await githubRepository.getMetadata()).organization;
		const [repoProjects, orgProjects] = (await Promise.all([githubRepository.getProjects(), (isInOrganization ? this.getOrgProjects(clearOrgCache) : undefined)]));
		return [...(repoProjects ?? []), ...(orgProjects ? orgProjects[githubRepository.remote.remoteName] : [])];
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
			Logger.error(`Resolving GitHub remotes failed: ${e}`, this.id);
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

		if (!githubRepositories || !githubRepositories.length || !this.repository.getRefs) {
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
				totalCount: 0
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
		const itemData: ItemsData = { hasMorePages: false, items: [], totalCount: 0 };
		const addPage = (page: PullRequestData | undefined) => {
			pagesFetched++;
			if (page) {
				itemData.items = itemData.items.concat(page.items);
				itemData.hasMorePages = page.hasMorePages;
				itemData.totalCount = page.totalCount;
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
			): Promise<{ items: any[]; hasMorePages: boolean, totalCount?: number } | undefined> => {
				// Resolve variables in the query with each repo
				const resolvedQuery = query ? await variableSubstitution(query, undefined,
					{ base: await githubRepository.getDefaultBranch(), owner: githubRepository.remote.owner, repo: githubRepository.remote.repositoryName }) : undefined;
				switch (pagedDataType) {
					case PagedDataType.PullRequest: {
						if (type === PRType.All) {
							return githubRepository.getAllPullRequests(pageNumber);
						} else {
							return this.getPullRequestsForCategory(githubRepository, resolvedQuery || '', pageNumber);
						}
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
					totalCount: itemData.totalCount,
				};
			}
		}

		return {
			items: itemData.items,
			hasMorePages: false,
			hasUnsearchedRepositories: false,
			totalCount: itemData.totalCount
		};
	}

	async getPullRequestsForCategory(githubRepository: GitHubRepository, categoryQuery: string, page?: number): Promise<PullRequestData | undefined> {
		let repo: IMetadata | undefined;
		try {
			Logger.debug(`Fetch pull request category ${categoryQuery} - enter`, this.id);
			const { octokit, query, schema } = await githubRepository.ensure();

			const user = (await githubRepository.getAuthenticatedUser()).login;
			// Search api will not try to resolve repo that redirects, so get full name first
			repo = await githubRepository.getMetadata();
			const { data, headers } = await octokit.call(octokit.api.search.issuesAndPullRequests, {
				q: getPRFetchQuery(user, categoryQuery),
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1,
			});

			const promises: Promise<{ data: PullRequestResponse, repo: GitHubRepository } | undefined>[] = data.items.map(async (item) => {
				const protocol = new Protocol(item.repository_url);

				const prRepo = await this.createGitHubRepositoryFromOwnerName(protocol.owner, protocol.repositoryName);
				const { data } = await query<PullRequestResponse>({
					query: schema.PullRequest,
					variables: {
						owner: prRepo.remote.owner,
						name: prRepo.remote.repositoryName,
						number: item.number
					}
				});
				return { data, repo: prRepo };
			});

			const hasMorePages = !!headers.link && headers.link.indexOf('rel="next"') > -1;
			const pullRequestResponses = await Promise.all(promises);

			const pullRequests = (await Promise.all(pullRequestResponses
				.map(async response => {
					if (!response?.data.repository) {
						Logger.appendLine('Pull request doesn\'t appear to exist.', this.id);
						return null;
					}

					// Pull requests fetched with a query can be from any repo.
					// We need to use the correct GitHubRepository for this PR.
					return response.repo.createOrUpdatePullRequestModel(
						await parseGraphQLPullRequest(response.data.repository.pullRequest, response.repo),
					);
				})))
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull request category ${categoryQuery} - done`, this.id);

			return {
				items: pullRequests,
				hasMorePages,
				totalCount: data.total_count
			};
		} catch (e) {
			Logger.error(`Fetching pull request with query failed: ${e}`, this.id);
			if (e.status === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote ${githubRepository.remote.remoteName} with query failed, please check if the repo ${repo?.full_name} is valid.`,
				);
			} else {
				throw e;
			}
		}
		return undefined;
	}

	isPullRequestAssociatedWithOpenRepository(pullRequest: PullRequestModel): boolean {
		const remote = pullRequest.githubRepository.remote;
		const repository = this.repository.state.remotes.find(repo => repo.name === remote.remoteName);
		if (repository) {
			return true;
		}

		return false;
	}

	async getPullRequests(
		type: PRType,
		options: IPullRequestsPagingOptions = { fetchNextPage: false },
		query?: string,
	): Promise<ItemsResponseResult<PullRequestModel>> {
		const queryId = type.toString() + (query || '');
		return this.fetchPagedData<PullRequestModel>(options, queryId, PagedDataType.PullRequest, type, query);
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
				number: data.number
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
	): Promise<ItemsResponseResult<IssueModel> | undefined> {
		if (this.gitHubRepositories.length === 0) {
			return undefined;
		}
		try {
			const data = await this.fetchPagedData<Issue>({ fetchNextPage: false, fetchOnePagePerRepo: false }, `issuesKey${query}`, PagedDataType.IssueSearch, PRType.All, query);
			const mappedData: ItemsResponseResult<IssueModel> = {
				items: [],
				hasMorePages: data.hasMorePages,
				hasUnsearchedRepositories: data.hasUnsearchedRepositories,
				totalCount: data.totalCount
			};
			for (const issue of data.items) {
				const githubRepository = await this.getRepoForIssue(issue);
				mappedData.items.push(new IssueModel(githubRepository, githubRepository.remote, issue));
			}
			return mappedData;
		} catch (e) {
			Logger.error(`Error fetching issues with query ${query}: ${e instanceof Error ? e.message : e}`, this.id);
			return { hasMorePages: false, hasUnsearchedRepositories: false, items: [], totalCount: 0 };
		}
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

	async getIssueTemplates(): Promise<vscode.Uri[]> {
		const pattern = '{docs,.github}/ISSUE_TEMPLATE/*.md';
		return vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri, pattern), null
		);
	}

	async getPullRequestTemplateBody(owner: string): Promise<string | undefined> {
		try {
			const template = await this.getPullRequestTemplateWithCache(owner);
			if (template) {
				return template;
			}

			// If there's no local template, look for a owner-wide template
			return this.getOwnerPullRequestTemplate(owner);
		} catch (e) {
			Logger.error(`Error fetching pull request template for ${owner}: ${e instanceof Error ? e.message : e}`, this.id);
		}
	}

	private async getPullRequestTemplateWithCache(owner: string): Promise<string | undefined> {
		const cacheLocation = `${CACHED_TEMPLATE_BODY}+${this.repository.rootUri.toString()}`;

		const findTemplate = this.getPullRequestTemplate(owner).then((template) => {
			//update cache
			if (template) {
				this.context.workspaceState.update(cacheLocation, template);
			} else {
				this.context.workspaceState.update(cacheLocation, null);
			}
			return template;
		});
		const hasCachedTemplate = this.context.workspaceState.keys().includes(cacheLocation);
		const cachedTemplate = this.context.workspaceState.get<string | null>(cacheLocation);
		if (hasCachedTemplate) {
			if (cachedTemplate === null) {
				return undefined;
			} else if (cachedTemplate) {
				return cachedTemplate;
			}
		}
		return findTemplate;
	}

	private async getOwnerPullRequestTemplate(owner: string): Promise<string | undefined> {
		const githubRepository = await this.createGitHubRepositoryFromOwnerName(owner, '.github');
		if (!githubRepository) {
			return undefined;
		}
		const templates = await githubRepository.getPullRequestTemplates();
		if (templates && templates?.length > 0) {
			return templates[0];
		}
	}

	private async getPullRequestTemplate(owner: string): Promise<string | undefined> {
		const repository = this.gitHubRepositories.find(repo => repo.remote.owner === owner);
		if (!repository) {
			return;
		}
		const templates = await repository.getPullRequestTemplates();
		return templates ? templates[0] : undefined;
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

	async getPullRequestDefaultRepo(): Promise<GitHubRepository> {
		const defaults = await this.getPullRequestDefaults();
		return this.findRepo(repo => repo.remote.owner === defaults.owner && repo.remote.repositoryName === defaults.repo) || this._githubRepositories[0];
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

	async getTipCommitMessage(branch: string): Promise<string | undefined> {
		Logger.debug(`Git tip message for branch ${branch} - enter`, this.id);
		const { repository } = this;
		let { commit } = await repository.getBranch(branch);
		let message: string = '';
		let count = 0;
		do {
			if (commit) {
				let fullCommit: Commit = await repository.getCommit(commit);
				if (fullCommit.parents.length <= 1) {
					message = fullCommit.message;
					break;
				} else {
					commit = fullCommit.parents[0];
				}
			}
			count++;
		} while (message === '' && commit && count < 5);


		Logger.debug(`Git tip message for branch ${branch} - done`, this.id);
		return message;
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

				Logger.error(`The remote '${upstreamRef.remote}' is not a GitHub repository.`, this.id);

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

			Logger.error(`Creating pull requests failed: ${e}`, this.id);

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
			Logger.error(` Creating issue failed: ${e}`, this.id);

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
			Logger.error(`Assigning issue failed: ${e}`, this.id);

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
		email?: string,
	): Promise<{ merged: boolean, message: string, timeline?: TimelineEvent[] }> {
		Logger.debug(`Merging PR: ${pullRequest.number} method: ${method} for user: "${email}" - enter`, this.id);
		const { mutate, schema } = await pullRequest.githubRepository.ensure();

		const activePRSHA = this.activePullRequest && this.activePullRequest.head && this.activePullRequest.head.sha;
		const workingDirectorySHA = this.repository.state.HEAD && this.repository.state.HEAD.commit;
		const mergingPRSHA = pullRequest.head && pullRequest.head.sha;
		const workingDirectoryIsDirty = this.repository.state.workingTreeChanges.length > 0;
		let expectedHeadOid: string | undefined = pullRequest.head?.sha;

		if (activePRSHA === mergingPRSHA) {
			// We're on the branch of the pr being merged.
			expectedHeadOid = workingDirectorySHA;
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
						message: vscode.l10n.t('unpushed changes'),
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
						message: vscode.l10n.t('uncommitted changes'),
					};
				}
			}
		}
		const input: MergePullRequestInput = {
			pullRequestId: pullRequest.graphNodeId,
			commitHeadline: title,
			commitBody: description,
			expectedHeadOid,
			authorEmail: email,
			mergeMethod:
				(method?.toUpperCase() ??
					vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'merge' | 'squash' | 'rebase'>(DEFAULT_MERGE_METHOD, 'merge')?.toUpperCase()) as GraphQLMergeMethod,
		};

		return mutate<MergePullRequestResponse>({
			mutation: schema.MergePullRequest,
			variables: {
				input
			}
		})
			.then(async (result) => {
				Logger.debug(`Merging PR: ${pullRequest.number}} - done`, this.id);

				/* __GDPR__
					"pr.merge.success" : {}
				*/
				this.telemetry.sendTelemetryEvent('pr.merge.success');
				this._onDidMergePullRequest.fire();
				return { merged: true, message: '', timeline: await parseCombinedTimelineEvents(result.data?.mergePullRequest.pullRequest.timelineItems.nodes ?? [], await pullRequest.getCopilotTimelineEvents(), pullRequest.githubRepository) };
			})
			.catch(e => {
				/* __GDPR__
					"pr.merge.failure" : {}
				*/
				this.telemetry.sendTelemetryErrorEvent('pr.merge.failure');
				const graphQLErrors = e.graphQLErrors as GraphQLError[] | undefined;
				if (graphQLErrors?.length && graphQLErrors.find(error => error.type === GraphQLErrorType.Unprocessable && error.message?.includes('Head branch was modified'))) {
					return { merged: false, message: vscode.l10n.t('Head branch was modified. Pull, review, then try again.') };
				} else {
					throw e;
				}
			});
	}

	async deleteBranch(pullRequest: PullRequestModel) {
		await pullRequest.githubRepository.deleteBranch(pullRequest);
	}

	private async getBranchDeletionItems() {
		interface BranchDeletionMetadata extends PullRequestMetadata {
			isOpen?: boolean;
		}

		const allConfigs = await this.repository.getConfigs();
		const branchInfos: Map<string, { remote?: string; metadata?: BranchDeletionMetadata[] }> = new Map();

		allConfigs.forEach(config => {
			const key = config.key;
			const matches = /^branch\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const branchName = matches[1];

				if (!branchInfos.has(branchName)) {
					branchInfos.set(branchName, {});
				}

				const value = branchInfos.get(branchName)!;
				if (matches[2] === 'remote') {
					value['remote'] = config.value;
				}

				if (matches[2] === 'github-pr-owner-number') {
					const metadata = PullRequestGitHelper.parsePullRequestMetadata(config.value);
					if (!value?.metadata) {
						value['metadata'] = [];
					}
					if (metadata) {
						// Check if the metadata already exists in the array
						const existingMetadata = value.metadata.find(m => m.owner === metadata.owner && m.repositoryName === metadata.repositoryName && m.prNumber === metadata.prNumber);
						if (!existingMetadata) {
							value['metadata'].push(metadata);
						}
					}
				}

				branchInfos.set(branchName, value!);
			}
		});
		Logger.debug(`Found ${branchInfos.size} possible branches to delete`, this.id);
		Logger.trace(`Branches to delete: ${JSON.stringify(Array.from(branchInfos.keys()))}`, this.id);

		const actions: (vscode.QuickPickItem & { metadata: BranchDeletionMetadata[]; legacy?: boolean })[] = [];
		branchInfos.forEach((value, key) => {
			if (value.metadata) {
				const activePRUrl = this.activePullRequest && this.activePullRequest.base.repositoryCloneUrl;
				const activeMetadata = value.metadata.find(metadata =>
					metadata.owner === activePRUrl?.owner &&
					metadata.repositoryName === activePRUrl?.repositoryName &&
					metadata.prNumber === this.activePullRequest?.number
				);

				if (!activeMetadata) {
					actions.push({
						label: `${key}`,
						picked: false,
						metadata: value.metadata,
					});
				} else {
					Logger.debug(`Skipping ${activeMetadata.prNumber}, active PR is #${this.activePullRequest?.number}`, this.id);
					Logger.trace(`Skipping active branch ${key}`, this.id);
				}
			}
		});

		const results = await Promise.all(
			actions.map(async action => {
				const allOld = (await Promise.all(
					action.metadata.map(async metadata => {
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
							metadata.isOpen = data.repository?.pullRequest.state === 'OPEN';
							return data.repository?.pullRequest.state !== 'OPEN';
						} catch { }
						return false;
					}))).every(result => result);
				if (allOld) {
					action.legacy = true;
				}

				return action;
			}),
		);

		results.forEach(result => {
			if (result.metadata.length === 0) {
				return;
			}
			result.description = `${result.metadata[0].repositoryName}/${result.metadata[0].owner} ${result.metadata.map(metadata => {
				const prString = `#${metadata.prNumber}`;
				return metadata.isOpen ? vscode.l10n.t('{0} is open', prString) : prString;
			}).join(', ')}`;
			if (result.legacy) {
				result.picked = true;
			}
		});

		return results;
	}

	public gitRelativeRootPath(path: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return nodePath.relative(this._repository.rootUri.path, path).replace(/\\/g, '/');
	}

	public async cleanupAfterPullRequest(branchName: string, pullRequest: PullRequestModel) {
		const defaults = await this.getPullRequestDefaults();
		if (branchName === defaults.base) {
			Logger.debug('Not cleaning up default branch.', this.id);
			return;
		}
		if (pullRequest.author.login === (await this.getCurrentUser()).login) {
			Logger.debug('Not cleaning up user\'s branch.', this.id);
			return;
		}
		const branch = await this.repository.getBranch(branchName);
		const remote = branch.upstream?.remote;
		try {
			Logger.debug(`Cleaning up branch ${branchName}`, this.id);
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
			Logger.debug(`Cleaning up remote ${remote}`, this.id);
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

	private async deleteBranches(picks: readonly vscode.QuickPickItem[], nonExistantBranches: Set<string>, progress: vscode.Progress<{ message?: string; increment?: number; }>, totalBranches: number, deletedBranches: number, needsRetry?: vscode.QuickPickItem[]) {
		const reportProgress = () => {
			deletedBranches++;
			progress.report({ message: vscode.l10n.t('Deleted {0} of {1} branches', deletedBranches, totalBranches) });
		};

		const deleteConfig = async (branch: string) => {
			await PullRequestGitHelper.associateBaseBranchWithBranch(this.repository, branch, undefined);
			await PullRequestGitHelper.associateBranchWithPullRequest(this.repository, undefined, branch);
		};

		// delete configs first since that can't be parallelized
		for (const pick of picks) {
			await deleteConfig(pick.label);
		}

		// batch deleting the branches to avoid consuming all available resources
		await batchPromiseAll(picks, 5, async (pick) => {
			try {
				await this.repository.deleteBranch(pick.label, true);
				if ((await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, pick.label))) {
					console.log(`Branch ${pick.label} was not deleted`);
				}
				reportProgress();
			} catch (e) {
				if (typeof e.stderr === 'string' && e.stderr.includes('not found')) {
					nonExistantBranches.add(pick.label);
					reportProgress();
				} else if (typeof e.stderr === 'string' && e.stderr.includes('unable to access') && needsRetry) {
					// There is contention for the related git files
					needsRetry.push(pick);
				} else {
					throw e;
				}
			}
		});
		if (needsRetry && needsRetry.length) {
			await this.deleteBranches(needsRetry, nonExistantBranches, progress, totalBranches, deletedBranches);
		}
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
				return result.picked && !((result.label === defaults.base) && (result.metadata.find(metadata => metadata.owner === defaults.owner && metadata.repositoryName === defaults.repo)));
			});
			quickPick.busy = false;
			if (results.length === 0) {
				quickPick.canSelectMany = false;
				quickPick.items = [{ label: vscode.l10n.t('No local branches to delete'), picked: false }];
			}

			let firstStep = true;
			quickPick.onDidAccept(async () => {
				quickPick.busy = true;

				if (firstStep) {
					const picks = quickPick.selectedItems;
					const nonExistantBranches = new Set<string>();
					if (picks.length) {
						await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Cleaning up') }, async (progress) => {
							try {
								await this.deleteBranches(picks, nonExistantBranches, progress, picks.length, 0, []);
							} catch (e) {
								quickPick.hide();
								vscode.window.showErrorMessage(vscode.l10n.t('Deleting branches failed: {0} {1}', e.message, e.stderr));
							}
						});
					}

					firstStep = false;
					const remoteItems = await this.getRemoteDeletionItems(nonExistantBranches);

					if (remoteItems && remoteItems.length) {
						quickPick.canSelectMany = true;
						quickPick.placeholder = vscode.l10n.t('Choose remotes you want to delete permanently');
						quickPick.items = remoteItems;
						quickPick.selectedItems = remoteItems.filter(item => item.picked);
					} else {
						quickPick.hide();
					}
				} else {
					// batch deleting the remotes to avoid consuming all available resources
					const picks = quickPick.selectedItems;
					if (picks.length) {
						await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deleting {0} remotes...', picks.length) }, async () => {
							await batchPromiseAll(picks, 5, async pick => {
								await this.repository.removeRemote(pick.label);
							});
						});
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

	async revert(pullRequest: PullRequestModel, title: string, body: string, draft: boolean): Promise<PullRequestModel | undefined> {
		const repo = this._githubRepositories.find(
			r => r.remote.owner === pullRequest.remote.owner && r.remote.repositoryName === pullRequest.remote.repositoryName,
		);
		if (!repo) {
			throw new Error(`No matching repository ${pullRequest.remote.repositoryName} found for ${pullRequest.remote.owner}`);
		}

		const pullRequestModel: PullRequestModel | undefined = await repo.revertPullRequest(pullRequest.graphNodeId, title, body, draft);
		return pullRequestModel;
	}

	async getPullRequestRepositoryDefaultBranch(issue: IssueModel): Promise<string> {
		const branch = await issue.githubRepository.getDefaultBranch();
		return branch;
	}

	async getPullRequestRepositoryAccessAndMergeMethods(
		issue: IssueModel,
	): Promise<RepoAccessAndMergeMethods> {
		const mergeOptions = await issue.githubRepository.getRepoAccessAndMergeMethods();
		return mergeOptions;
	}

	async mergeQueueMethodForBranch(branch: string, owner: string, repoName: string): Promise<MergeMethod | undefined> {
		return (await this.gitHubRepositories.find(repository => repository.remote.owner === owner && repository.remote.repositoryName === repoName)?.mergeQueueMethodForBranch(branch));
	}

	async fulfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		try {
			if (!pullRequest.isResolved()) {
				return;
			}

			Logger.debug(`Fulfill pull request missing info - start`, this.id);
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
		Logger.debug(`Fulfill pull request missing info - done`, this.id);
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
			Logger.appendLine(`GitHubRepository not found: ${owner}/${repositoryName}`, this.id);
			// try to create the repository
			githubRepo = await this.createGitHubRepositoryFromOwnerName(owner, repositoryName);
		}
		return githubRepo;
	}

	async resolveIssueOrPullRequest(owner: string, repositoryName: string, issueOrPullRequestNumber: number): Promise<PullRequestModel | IssueModel | undefined> {
		let issueOrPullRequest: IssueModel | PullRequestModel | undefined = await this.resolveIssue(owner, repositoryName, issueOrPullRequestNumber, true);
		if (!issueOrPullRequest) {
			issueOrPullRequest = await this.resolvePullRequest(owner, repositoryName, issueOrPullRequestNumber);
		}
		return issueOrPullRequest;
	}

	async resolvePullRequest(
		owner: string,
		repositoryName: string,
		pullRequestNumber: number,
	): Promise<PullRequestModel | undefined> {
		const githubRepo = await this.resolveItem(owner, repositoryName);
		Logger.appendLine(`Found GitHub repo for pr #${pullRequestNumber}: ${githubRepo ? 'yes' : 'no'}`, this.id);
		if (githubRepo) {
			const pr = await githubRepo.getPullRequest(pullRequestNumber);
			Logger.appendLine(`Found GitHub pr repo for pr #${pullRequestNumber}: ${pr ? 'yes' : 'no'}`, this.id);
			return pr;
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
		Logger.debug(`Fetch user ${login}`, this.id);
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

	async getMatchingPullRequestMetadataFromGitHub(branch: Branch, remoteName?: string, remoteUrl?: string, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		try {
			if (remoteName) {
				return this.getMatchingPullRequestMetadataFromGitHubWithRemoteName(remoteName, upstreamBranchName);
			}
			return this.getMatchingPullRequestMetadataFromGitHubWithUrl(branch, remoteUrl, upstreamBranchName);
		} catch (e) {
			Logger.error(`Unable to get matching pull request metadata from GitHub: ${e}`, this.id);
			return null;
		}
	}

	async getMatchingPullRequestMetadataFromGitHubWithUrl(branch: Branch, remoteUrl?: string, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		Logger.debug(`Searching GitHub for a PR with branch ${upstreamBranchName} and remote ${remoteUrl}`, this.id);

		if (!remoteUrl) {
			return null;
		}
		const protocol: Protocol = new Protocol(remoteUrl);
		let headGitHubRepo = this.findRepo((input) => compareIgnoreCase(input.remote.owner, protocol.owner) === 0 && compareIgnoreCase(input.remote.repositoryName, protocol.repositoryName) === 0);
		if (!headGitHubRepo && this.gitHubRepositories.length > 0) {
			const remote = parseRemote(protocol.repositoryName, remoteUrl, protocol);
			if (remote) {
				headGitHubRepo = await this.createGitHubRepository(remote, this.credentialStore, true, true);
			}
		}
		const matchingPR = await this.doGetMatchingPullRequestMetadataFromGitHub(headGitHubRepo, upstreamBranchName);
		if (matchingPR && (branch.upstream === undefined) && headGitHubRepo && branch.name) {
			const newRemote = await PullRequestGitHelper.createRemote(this.repository, headGitHubRepo?.remote, protocol);
			const trackedBranchName = `refs/remotes/${newRemote}/${matchingPR.model.head?.name}`;
			await this.repository.fetch({ remote: newRemote, ref: matchingPR.model.head?.name });
			await this.repository.setBranchUpstream(branch.name, trackedBranchName);
		}

		return matchingPR;
	}

	async getMatchingPullRequestMetadataFromGitHubWithRemoteName(remoteName?: string, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		Logger.debug(`Searching GitHub for a PR with branch ${upstreamBranchName} and remote ${remoteName}`, this.id);
		if (!remoteName) {
			return null;
		}

		let headGitHubRepo = this.gitHubRepositories.find(
			repo => repo.remote.remoteName === remoteName,
		);

		if (!headGitHubRepo && this.gitHubRepositories.length > 0) {
			const gitRemote = this.repository.state.remotes.find(remote => remote.name === remoteName);
			const remoteUrl = gitRemote?.fetchUrl ?? gitRemote?.pushUrl;
			if (!remoteUrl) {
				return null;
			}
			const protocol = new Protocol(remoteUrl ?? '');
			const remote = parseRemote(remoteName, remoteUrl, protocol);
			if (remote) {
				headGitHubRepo = await this.createGitHubRepository(remote, this.credentialStore, true, true);
			}
		}

		return this.doGetMatchingPullRequestMetadataFromGitHub(headGitHubRepo, upstreamBranchName);
	}

	private async doGetMatchingPullRequestMetadataFromGitHub(headGitHubRepo?: GitHubRepository, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		if (!headGitHubRepo || !upstreamBranchName) {
			return null;
		}

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

	async tryMergeBaseIntoHead(pullRequest: PullRequestModel, push: boolean): Promise<boolean> {
		if (await this.isHeadUpToDateWithBase(pullRequest)) {
			return true;
		}

		const isBrowser = (vscode.env.appHost === 'vscode.dev' || vscode.env.appHost === 'github.dev');
		if (!pullRequest.isActive || isBrowser) {
			const conflictModel = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Finding conflicts...') }, () => createConflictResolutionModel(pullRequest));
			if (conflictModel === undefined) {
				await vscode.window.showErrorMessage(vscode.l10n.t('Unable to resolved conflicts for this pull request. There are too many file changes.'), { modal: true, detail: isBrowser ? undefined : vscode.l10n.t('Please check out the pull request to resolve conflicts.') });
				return false;
			}
			let continueWithMerge = true;
			if (pullRequest.item.mergeable === PullRequestMergeability.Conflict) {
				const githubRepos = await Promise.all([this.createGitHubRepositoryFromOwnerName(pullRequest.head!.owner, pullRequest.head!.repositoryCloneUrl.repositoryName), this.createGitHubRepositoryFromOwnerName(pullRequest.base.owner, pullRequest.base.repositoryCloneUrl.repositoryName)]);
				const coordinator = new ConflictResolutionCoordinator(this.telemetry, conflictModel, githubRepos);
				continueWithMerge = await coordinator.enterConflictResolutionAndWaitForExit();
				coordinator.dispose();
			}

			if (continueWithMerge) {
				return pullRequest.updateBranch(conflictModel);
			} else {
				return false;
			}
		}

		if (this.repository.state.workingTreeChanges.length > 0 || this.repository.state.indexChanges.length > 0) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch cannot be updated when the there changed files in the working tree or index. Stash or commit all change and then try again.'), { modal: true });
			return false;
		}
		const baseRemote = findLocalRepoRemoteFromGitHubRef(this.repository, pullRequest.base)?.name;
		if (!baseRemote) {
			return false;
		}
		const qualifiedUpstream = `${baseRemote}/${pullRequest.base.ref}`;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
			progress.report({ message: vscode.l10n.t('Fetching branch {0}', qualifiedUpstream) });
			await this.repository.fetch({ ref: pullRequest.base.ref, remote: baseRemote });
			progress.report({ message: vscode.l10n.t('Merging branch {0} into {1}', qualifiedUpstream, this.repository.state.HEAD!.name!) });
			try {
				await this.repository.merge(qualifiedUpstream);
			} catch (e) {
				if (e.gitErrorCode !== GitErrorCodes.Conflict) {
					throw e;
				}
			}
		});

		if (pullRequest.item.mergeable === PullRequestMergeability.Conflict) {
			const wizard = await ConflictModel.begin(this.repository, pullRequest.base.ref, this.repository.state.HEAD!.name!, push);
			await wizard?.finished();
			wizard?.dispose();
		} else {
			await this.repository.push();
		}
		return true;
	}

	async isHeadUpToDateWithBase(pullRequestModel: PullRequestModel): Promise<boolean> {
		if (!pullRequestModel.head) {
			return false;
		}
		const repo = this._githubRepositories.find(
			r => r.remote.owner === pullRequestModel.remote.owner && r.remote.repositoryName === pullRequestModel.remote.repositoryName,
		);
		const headBranch = `${pullRequestModel.head.owner}:${pullRequestModel.head.ref}`;
		const baseBranch = `${pullRequestModel.base.owner}:${pullRequestModel.base.ref}`;
		const log = await repo?.compareCommits(baseBranch, headBranch);
		return log?.behind_by === 0;
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
				try {
					await this.repository.fetch({ remote: branchObj.upstream.remote, ref: `${branchObj.upstream.name}:${branchObj.name}` });
				} catch (e) {
					if (e.stderr?.startsWith && e.stderr.startsWith('fatal: refusing to fetch into branch')) {
						// This can happen when there's some state on the "main" branch
						// This could be unpushed commits or a bisect for example
						vscode.window.showErrorMessage(vscode.l10n.t('Unable to fetch the {0} branch. There is some state (bisect, unpushed commits, etc.) on {0} that is preventing the fetch.', [branchObj.name]));
					} else {
						throw e;
					}
				}
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
			Logger.error(`Exiting failed: ${e}. Target branch ${branch} used to find branch ${branchObj?.name ?? 'unknown'} with upstream ${branchObj?.upstream?.name ?? 'unknown'}.`, this.id);
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
					if (shouldFetch && vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(ALLOW_FETCH, true)) {
						await this._repository.fetch(remote, remoteBranch);
					}
				} catch (e) {
					if (e.stderr) {
						if ((e.stderr as string).startsWith('fatal: couldn\'t find remote ref')) {
							// We've managed to check out the PR, but the remote has been deleted. This is fine, but we can't fetch now.
						} else if ((e.stderr as string).includes('key_exchange_identification')) {
							// Another reason we can't fetch now. https://github.com/microsoft/vscode-pull-request-github/issues/6681
						} else {
							vscode.window.showErrorMessage(vscode.l10n.t('An error occurred when fetching the repository: {0}', e.stderr));
						}
					}
					Logger.error(`Error when fetching: ${e.stderr ?? e}`, this.id);
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

	public findExistingGitHubRepository(remote: { owner: string, repositoryName: string, remoteName?: string }): GitHubRepository | undefined {
		return this._githubRepositories.find(
			r =>
				(r.remote.owner.toLowerCase() === remote.owner.toLowerCase())
				&& (r.remote.repositoryName.toLowerCase() === remote.repositoryName.toLowerCase())
				&& (!remote.remoteName || (r.remote.remoteName === remote.remoteName)),
		);
	}

	private async createAndAddGitHubRepository(remote: Remote, credentialStore: CredentialStore, silent?: boolean) {
		const repoId = this._id + (this._githubRepositories.length * 0.1);
		const repo = new GitHubRepository(repoId, GitHubRemote.remoteAsGitHub(remote, await this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)), this.repository.rootUri, credentialStore, this.telemetry, silent);
		this._githubRepositories.push(repo);
		return repo;
	}

	private removeGitHubRepository(remote: Remote) {
		const index = this._githubRepositories.findIndex(
			r =>
				(r.remote.owner.toLowerCase() === remote.owner.toLowerCase())
				&& (r.remote.repositoryName.toLowerCase() === remote.repositoryName.toLowerCase())
				&& (!remote.remoteName || (r.remote.remoteName === remote.remoteName))
		);
		if (index > -1) {
			this._githubRepositories.splice(index, 1);
		}
	}

	private _createGitHubRepositoryBulkhead = bulkhead(1, 300);
	async createGitHubRepository(remote: Remote, credentialStore: CredentialStore, silent?: boolean, ignoreRemoteName: boolean = false): Promise<GitHubRepository> {
		// Use a bulkhead/semaphore to ensure that we don't create multiple GitHubRepositories for the same remote at the same time.
		return this._createGitHubRepositoryBulkhead.execute(async () => {
			return this.findExistingGitHubRepository({ owner: remote.owner, repositoryName: remote.repositoryName, remoteName: ignoreRemoteName ? undefined : remote.remoteName }) ??
				await this.createAndAddGitHubRepository(remote, credentialStore, silent);
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
		const startingRepoCount = this.gitHubRepositories.length;
		await matchingRepo.renameRemote(workingRemoteName, 'upstream');
		await matchingRepo.addRemote(workingRemoteName, result);
		// Now the extension is responding to all the git changes.
		await new Promise<void>(resolve => {
			if (this.gitHubRepositories.length === startingRepoCount) {
				const disposable = this.onDidChangeRepositories(() => {
					if (this.gitHubRepositories.length > startingRepoCount) {
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

	public async publishBranch(pushRemote: Remote, branchName: string): Promise<GitHubRemote | undefined> {
		const githubRepo = await this.createGitHubRepository(
			pushRemote,
			this.credentialStore,
		);
		const permission = await githubRepo.getViewerPermission();
		let selectedRemote: GitHubRemote | undefined;
		if (
			permission === ViewerPermission.Read ||
			permission === ViewerPermission.Triage ||
			permission === ViewerPermission.Unknown
		) {
			// No permission to publish the branch to the chosen remote. Offer to fork.
			const fork = await this.tryOfferToFork(githubRepo);
			if (!fork) {
				return;
			}

			selectedRemote = (await this.getGitHubRemotes()).find(element => element.remoteName === fork);
		} else {
			selectedRemote = (await this.getGitHubRemotes()).find(element => element.remoteName === pushRemote.remoteName);
		}

		if (!selectedRemote) {
			return;
		}

		try {
			await this._repository.push(selectedRemote.remoteName, branchName, true);
			await this._repository.status();
			return selectedRemote;
		} catch (err) {
			if (err.gitErrorCode === GitErrorCodes.PushRejected) {
				vscode.window.showWarningMessage(
					vscode.l10n.t(`Can't push refs to remote, try running 'git pull' first to integrate with your change`),
					{
						modal: true,
					},
				);

				return undefined;
			}

			if (err.gitErrorCode === GitErrorCodes.RemoteConnectionError) {
				vscode.window.showWarningMessage(
					vscode.l10n.t(`Could not read from remote repository '{0}'. Please make sure you have the correct access rights and the repository exists.`, selectedRemote.remoteName),
					{
						modal: true,
					},
				);

				return undefined;
			}

			// we can't handle the error
			throw err;
		}
	}

	public saveLastUsedEmail(email: string | undefined) {
		return this.context.globalState.update(LAST_USED_EMAIL, email);
	}

	public async getPreferredEmail(pullRequest: PullRequestModel): Promise<string | undefined> {
		const isEmu = await this.credentialStore.getIsEmu(pullRequest.remote.authProviderId);
		if (isEmu) {
			return undefined;
		}

		const gitHubEmails = await pullRequest.githubRepository.getAuthenticatedUserEmails();
		const getMatch = (match: string | undefined) => match && gitHubEmails.find(email => email.toLowerCase() === match.toLowerCase());

		const gitEmail = await PullRequestGitHelper.getEmail(this.repository);
		let match = getMatch(gitEmail);
		if (match) {
			return match;
		}

		const lastUsedEmail = this.context.globalState.get<string>(LAST_USED_EMAIL);
		match = getMatch(lastUsedEmail);
		if (match) {
			return match;
		}

		return gitHubEmails[0];
	}

	public getTitleAndDescriptionProvider(searchTerm?: string) {
		return this._git.getTitleAndDescriptionProvider(searchTerm);
	}

	public getAutoReviewer() {
		return this._git.getReviewerCommentsProvider();
	}

	override dispose() {
		this._onDidDispose.fire();
		super.dispose();
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

export const titleAndBodyFrom = async (promise: Promise<string | undefined>): Promise<{ title: string; body: string } | undefined> => {
	const message = await promise;
	if (!message) {
		return;
	}
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1 ? message : message.substr(0, idxLineBreak),

		body: idxLineBreak === -1 ? '' : message.slice(idxLineBreak + 1).trim(),
	};
};
