/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import {
	GitPullRequest,
	GitPullRequestSearchCriteria,
	PullRequestStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import type { Repository, UpstreamRef } from '../api/api';
import { GitApiImpl, GitErrorCodes, RefType } from '../api/api1';
import { AzdoManager } from '../authentication/azdoServer';
import Logger from '../common/logger';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { EventType, TimelineEvent } from '../common/timelineEvent';
import { fromPRUri } from '../common/uri';
import { formatError, Predicate } from '../common/utils';
import { EXTENSION_ID, SETTINGS_NAMESPACE, URI_SCHEME_PR } from '../constants';
import { AzdoRepository } from './azdoRepository';
import { CredentialStore } from './credentials';
import { FileReviewedStatusService } from './fileReviewedStatusService';
import { IAccount, IPullRequestsPagingOptions, PRType, RepoAccessAndMergeMethods } from './interface';
import { PullRequestGitHelper, PullRequestMetadata } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { convertRESTIdentityToAccount, getRelatedUsersFromPullrequest, loginComparator, UserCompletion } from './utils';

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
		return `${this.repository.rootUri.toString()} has no GitHub remotes`;
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has a detached HEAD (create a branch first)`;
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
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

export const REMOTES_SETTING = 'remotes';

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
	private _azdoRepositories: AzdoRepository[];
	private _allGitHubRemotes: Remote[] = [];
	private _mentionableUsers?: { [key: string]: IAccount[] };
	private _fetchMentionableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _assignableUsers?: { [key: string]: IAccount[] };
	private _fetchAssignableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _gitBlameCache: { [key: string]: string } = {};
	private _githubManager: AzdoManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;
	private _onDidChangeActiveIssue = new vscode.EventEmitter<void>();
	readonly onDidChangeActiveIssue: vscode.Event<void> = this._onDidChangeActiveIssue.event;

	private _onDidLoadRepositories = new vscode.EventEmitter<ReposManagerState>();
	readonly onDidLoadRepositories: vscode.Event<ReposManagerState> = this._onDidLoadRepositories.event;

	private _onDidChangeRepositories = new vscode.EventEmitter<void>();
	readonly onDidChangeRepositories: vscode.Event<void> = this._onDidChangeRepositories.event;

	private _onDidChangeAssignableUsers = new vscode.EventEmitter<IAccount[]>();
	readonly onDidChangeAssignableUsers: vscode.Event<IAccount[]> = this._onDidChangeAssignableUsers.event;

	constructor(
		private _repository: Repository,
		private readonly _telemetry: ITelemetry,
		private _git: GitApiImpl,
		private _credentialStore: CredentialStore,
		private _fileReviewedStatusService: FileReviewedStatusService,
	) {
		this._subs = [];
		this._azdoRepositories = [];
		this._githubManager = new AzdoManager();

		this._subs.push(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${REMOTES_SETTING}`)) {
					await this.updateRepositories();
				}
			}),
		);

		this.setUpCompletionItemProvider();
	}

	get azdoRepositories(): AzdoRepository[] {
		return this._azdoRepositories;
	}

	private computeAllGitHubRemotes(): Promise<Remote[]> {
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		return Promise.all(potentialRemotes.map(remote => this._githubManager.isAzdo(remote.gitProtocol.normalizeUri()!)))
			.then(results => potentialRemotes.filter((_, index, __) => results[index]))
			.catch(e => {
				Logger.appendLine(`Resolving Azdo remotes failed: ${e}`, FolderRepositoryManager.ID);
				vscode.window.showErrorMessage(`Resolving Azdo remotes failed: ${formatError(e)}`, FolderRepositoryManager.ID);
				return [];
			});
	}

	public async getActiveGitHubRemotes(allGitHubRemotes: Remote[]): Promise<Remote[]> {
		const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);

		if (!remotesSetting) {
			Logger.appendLine(`Unable to read remotes setting`, FolderRepositoryManager.ID);
			return Promise.resolve([]);
		}

		remotesSetting.forEach(remote => {
			if (!allGitHubRemotes.some(repo => repo.remoteName === remote)) {
				Logger.appendLine(
					`No remote with name '${remote}' found. All other remotes: ${allGitHubRemotes
						.map(r => r.remoteName)
						.join(',')}`,
					FolderRepositoryManager.ID,
				);
			}
		});

		Logger.debug(`Displaying configured remotes: ${remotesSetting.join(', ')}`, FolderRepositoryManager.ID);

		return remotesSetting
			.map(remote => allGitHubRemotes.find(repo => repo.remoteName === remote))
			.filter((repo: Remote | undefined): repo is Remote => !!repo);
	}

	public setUpCompletionItemProvider() {
		let lastPullRequest: PullRequestModel | undefined = undefined;
		const lastPullRequestTimelineEvents: TimelineEvent[] = [];
		let cachedUsers: UserCompletion[] = [];

		vscode.languages.registerCompletionItemProvider(
			{ scheme: 'comment' },
			{
				provideCompletionItems: async (document, position) => {
					try {
						const query = JSON.parse(document.uri.query);
						if (query.extensionId !== EXTENSION_ID) {
							// TODO Change extension id
							return;
						}

						const wordRange = document.getWordRangeAtPosition(
							position,
							/@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})?/i,
						);
						if (!wordRange || wordRange.isEmpty) {
							return;
						}

						let prRelatedusers: { login: string; name?: string; email?: string }[] = [];
						const fileRelatedUsersNames: { [key: string]: boolean } = {};
						let mentionableUsers: { [key: string]: { id?: string; name?: string; email?: string }[] } = {};
						let prNumber: number | undefined;
						let remoteName: string | undefined;

						const activeTextEditors = vscode.window.visibleTextEditors;
						if (activeTextEditors.length) {
							const visiblePREditor = activeTextEditors.find(
								editor => editor.document.uri.scheme === URI_SCHEME_PR,
							);

							if (visiblePREditor) {
								const params = fromPRUri(visiblePREditor.document.uri);
								prNumber = params!.prNumber;
								remoteName = params!.remoteName;
							} else if (this._activePullRequest) {
								prNumber = this._activePullRequest.getPullRequestId();
								remoteName = this._activePullRequest.remote.remoteName;
							}

							if (lastPullRequest && prNumber && prNumber === lastPullRequest.getPullRequestId()) {
								return cachedUsers;
							}
						}

						const prRelatedUsersPromise = new Promise<void>(async resolve => {
							if (prNumber && remoteName) {
								Logger.debug('get Timeline Events and parse users', FolderRepositoryManager.ID);
								if (lastPullRequest && lastPullRequest.getPullRequestId() === prNumber) {
									// TODO This will always be empty
									return lastPullRequestTimelineEvents;
								}

								const githubRepo = this._azdoRepositories.find(repo => repo.remote.remoteName === remoteName);

								if (githubRepo) {
									lastPullRequest = await githubRepo.getPullRequest(prNumber);
								}

								const [threads, commits] = await Promise.all([
									lastPullRequest?.getAllActiveThreadsBetweenAllIterations(),
									lastPullRequest?.getCommits(),
								]);

								prRelatedusers = getRelatedUsersFromPullrequest(lastPullRequest!.item!, threads, commits);
								resolve();
							}

							resolve();
						});

						const fileRelatedUsersNamesPromise = new Promise<void>(async resolve => {
							if (activeTextEditors.length) {
								try {
									Logger.debug('git blame and parse users', FolderRepositoryManager.ID);
									const fsPath = path.resolve(activeTextEditors[0].document.uri.fsPath);
									let blames: string | undefined;
									if (this._gitBlameCache[fsPath]) {
										blames = this._gitBlameCache[fsPath];
									} else {
										blames = await this.repository.blame(fsPath);
										this._gitBlameCache[fsPath] = blames;
									}

									const blameLines = blames.split('\n');

									for (const line of blameLines) {
										const matches = /^\w{11} \S*\s*\((.*)\s*\d{4}\-/.exec(line);

										if (matches && matches.length === 2) {
											const name = matches[1].trim();
											fileRelatedUsersNames[name] = true;
										}
									}
								} catch (err) {
									Logger.debug(err, FolderRepositoryManager.ID);
								}
							}

							resolve();
						});

						const getMentionableUsersPromise = new Promise<void>(async resolve => {
							Logger.debug('get mentionable users', FolderRepositoryManager.ID);
							mentionableUsers = await this.getMentionableUsers();
							resolve();
						});

						await Promise.all([prRelatedUsersPromise, fileRelatedUsersNamesPromise, getMentionableUsersPromise]);

						cachedUsers = [];
						const prRelatedUsersMap: { [key: string]: { login: string; name?: string; email?: string } } = {};
						Logger.debug('prepare user suggestions', FolderRepositoryManager.ID);

						prRelatedusers.forEach(user => {
							if (!prRelatedUsersMap[user.login]) {
								prRelatedUsersMap[user.login] = user;
							}
						});

						const secondMap: { [key: string]: boolean } = {};

						for (const mentionableUserGroup in mentionableUsers) {
							// eslint-disable-next-line no-loop-func
							mentionableUsers[mentionableUserGroup].forEach(user => {
								if (!prRelatedUsersMap[user.id!] && !secondMap[user.id!]) {
									secondMap[user.id!] = true;

									let priority = 2;
									if (fileRelatedUsersNames[user.id!] || (user.name && fileRelatedUsersNames[user.name])) {
										priority = 1;
									}

									if (prRelatedUsersMap[user.id!]) {
										priority = 0;
									}

									cachedUsers.push({
										label: user.id!,
										email: user.email,
										insertText: user.id!,
										filterText:
											`${user.id!}` +
											(user.name && user.name !== user.id!
												? `_${user.name.toLowerCase().replace(' ', '_')}`
												: ''),
										sortText: `${priority}_${user.id!}`,
										detail: user.name,
										kind: vscode.CompletionItemKind.User,
										login: user.id!,
										uri: this.repository.rootUri,
									});
								}
							});
						}

						for (const user in prRelatedUsersMap) {
							if (!secondMap[user]) {
								// if the mentionable api call fails partially, we should still populate related users from timeline events into the completion list
								cachedUsers.push({
									label: prRelatedUsersMap[user].login,
									insertText: `${prRelatedUsersMap[user].login}`,
									filterText:
										`${prRelatedUsersMap[user].login}` +
										(prRelatedUsersMap[user].name &&
										prRelatedUsersMap[user].name !== prRelatedUsersMap[user].login
											? `_${prRelatedUsersMap[user].name!.toLowerCase().replace(' ', '_')}`
											: ''),
									sortText: `0_${prRelatedUsersMap[user].login}`,
									detail: prRelatedUsersMap[user].name,
									kind: vscode.CompletionItemKind.User,
									login: prRelatedUsersMap[user].login,
									uri: this.repository.rootUri,
									email: prRelatedUsersMap[user].email,
								});
							}
						}

						Logger.debug('done', FolderRepositoryManager.ID);
						return cachedUsers;
					} catch (e) {
						return [];
					}
				},
				resolveCompletionItem: async (item: vscode.CompletionItem) => {
					// try {
					// 	const repo = await this.getPullRequestDefaults();
					// 	const user: User | undefined = await this.resolveUser(repo.owner, repo.repo, item.label);
					// 	if (user) {
					// 		item.documentation = userMarkdown(repo, user);
					// 	}
					// } catch (e) {
					// 	// The user might not be resolvable in the repo, since users from outside the repo are included in the list.
					// }
					return item;
				},
			},
			'@',
		);
	}

	get activePullRequest(): PullRequestModel | undefined {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: PullRequestModel | undefined) {
		if (this._activePullRequest) {
			this._activePullRequest.isActive = false;
		}

		if (pullRequest) {
			pullRequest.isActive = true;
		}

		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
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

	private async getActiveRemotes(): Promise<Remote[]> {
		this._allGitHubRemotes = await this.computeAllGitHubRemotes();
		const activeRemotes = await this.getActiveGitHubRemotes(this._allGitHubRemotes);

		if (activeRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'azdo:hasAzdoRemotes', true);
			Logger.appendLine(
				`Found Azdo remotes ${activeRemotes.map(r => r.remoteName).join(',')}`,
				FolderRepositoryManager.ID,
			);
		} else {
			await vscode.commands.executeCommand('setContext', 'azdo:hasAzdoRemotes', false);
			Logger.appendLine(
				`No Azdo remotes found. All remotes: ${this._allGitHubRemotes.map(r => r.remoteName).join(',')}`,
				FolderRepositoryManager.ID,
			);
		}

		return activeRemotes;
	}

	async updateRepositories(silent: boolean = false): Promise<void> {
		if (this._git.state === 'uninitialized') {
			return;
		}

		const activeRemotes = await this.getActiveRemotes();
		const isAuthenticated = this._credentialStore.isAuthenticated();
		vscode.commands.executeCommand('setContext', 'azdo:authenticated', isAuthenticated);

		const repositories: AzdoRepository[] = [];
		const resolveRemotePromises: Promise<void>[] = [];

		const authenticatedRemotes = isAuthenticated ? activeRemotes : [];
		authenticatedRemotes.forEach(remote => {
			const repository = this.createAzdoRepository(remote, this._credentialStore, this._fileReviewedStatusService);
			resolveRemotePromises.push(repository.resolveRemote());
			repositories.push(repository);
		});

		return Promise.all(resolveRemotePromises).then(_ => {
			const oldRepositories = this._azdoRepositories;
			this._azdoRepositories = repositories;
			oldRepositories.forEach(repo => repo.dispose());

			const repositoriesChanged =
				oldRepositories.length !== this._azdoRepositories.length ||
				!oldRepositories.every(oldRepo =>
					this._azdoRepositories.some(newRepo => newRepo.remote.equals(oldRepo.remote)),
				);

			this.getMentionableUsers(repositoriesChanged);
			this.getAssignableUsers(repositoriesChanged);
			this._onDidLoadRepositories.fire(
				isAuthenticated || !activeRemotes.length
					? ReposManagerState.RepositoriesLoaded
					: ReposManagerState.NeedsAuthentication,
			);
			if (!silent) {
				this._onDidChangeRepositories.fire();
			}
			return Promise.resolve();
		});
	}

	getAllAssignableUsers(): IAccount[] | undefined {
		if (this._assignableUsers) {
			const allAssignableUsers: IAccount[] = [];
			Object.keys(this._assignableUsers).forEach(k => {
				allAssignableUsers.push(...this._assignableUsers![k]);
			});

			return allAssignableUsers;
		}
	}

	async getMentionableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._mentionableUsers;
		}

		if (this._mentionableUsers) {
			return this._mentionableUsers;
		}

		if (!this._fetchMentionableUsersPromise) {
			const cache: { [key: string]: IAccount[] } = {};
			return (this._fetchMentionableUsersPromise = new Promise(resolve => {
				const promises = this._azdoRepositories.map(async repo => {
					const data = await repo.getMentionableUsers();
					cache[repo.remote.remoteName] = data;
					return;
				});

				Promise.all(promises).then(() => {
					this._mentionableUsers = cache;
					this._fetchMentionableUsersPromise = undefined;
					resolve(cache);
				});
			}));
		}

		return this._fetchMentionableUsersPromise;
	}

	async getAssignableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._assignableUsers;
		}

		if (this._assignableUsers) {
			return this._assignableUsers;
		}

		if (!this._fetchAssignableUsersPromise) {
			const cache: { [key: string]: IAccount[] } = {};
			const allAssignableUsers: IAccount[] = [];
			return (this._fetchAssignableUsersPromise = new Promise(resolve => {
				const promises = this._azdoRepositories.map(async repo => {
					const data = await repo.getAssignableUsers();
					cache[repo.remote.remoteName] = data.sort(loginComparator);
					allAssignableUsers.push(...data);
					return;
				});

				Promise.all(promises).then(() => {
					this._assignableUsers = cache;
					this._fetchAssignableUsersPromise = undefined;
					resolve(cache);
					this._onDidChangeAssignableUsers.fire(allAssignableUsers);
				});
			}));
		}

		return this._fetchAssignableUsersPromise;
	}

	/**
	 * Returns the remotes that are currently active, which is those that are important by convention (origin, upstream),
	 * or the remotes configured by the setting githubPullRequests.remotes
	 */
	getGitHubRemotes(): Remote[] {
		const githubRepositories = this._azdoRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		return githubRepositories.map(repository => repository.remote);
	}

	/**
	 * Returns all remotes from the repository.
	 */
	async getAllGitHubRemotes(): Promise<Remote[]> {
		return await this.computeAllGitHubRemotes();
	}

	async getLocalPullRequests(): Promise<PullRequestModel[]> {
		const githubRepositories = this._azdoRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = this.repository.state.refs
			.filter(r => r.type === RefType.Head && r.name !== undefined)
			.map(r => r.name!);

		const promises = localBranches.map(async localBranchName => {
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

			return Promise.resolve(null);
		});

		return Promise.all(promises).then(values => {
			return values.filter(value => value !== null) as PullRequestModel[];
		});
	}

	// async getLabels(issue?: IssueModel, repoInfo?: { owner: string, repo: string }): Promise<ILabel[]> {
	// 	const repo = issue ? issue.githubRepository : this._azdoRepositories.find(r => r.remote.owner === repoInfo?.owner && r.remote.repositoryName === repoInfo?.repo);
	// 	if (!repo) {
	// 		throw new Error(`No matching repository found for getting labels.`);
	// 	}

	// 	const { remote, octokit } = await repo.ensure();
	// 	let hasNextPage = false;
	// 	let page = 1;
	// 	let results: ILabel[] = [];

	// 	do {
	// 		const result = await octokit.issues.listLabelsForRepo({
	// 			owner: remote.owner,
	// 			repo: remote.repositoryName,
	// 			page
	// 		});

	// 		results = results.concat(result.data.map(label => {
	// 			return {
	// 				name: label.name,
	// 				color: label.color
	// 			};
	// 		}));

	// 		results = results.sort((a, b) => a.name.localeCompare(b.name));

	// 		hasNextPage = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
	// 		page += 1;
	// 	} while (hasNextPage);

	// 	return results;
	// }

	async listBranches(owner: string, repo: string): Promise<string[]> {
		const repository = this._azdoRepositories.find(r => r.remote.owner === owner && r.remote.repositoryName === repo);
		if (!repository) {
			throw new Error('No matching repository found');
		}

		return repository.listBranches();
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel, force?: boolean): Promise<void> {
		if (!pullRequest.localBranchName) {
			return;
		}
		await this.repository.deleteBranch(pullRequest.localBranchName, force);

		let remoteName: string | undefined = undefined;
		try {
			remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		} catch (e) {}

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
		this._telemetry.sendTelemetryEvent('branch.delete');
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
		type: PRType = PRType.AllActive,
		_query?: string,
		prSearchCriteria?: GitPullRequestSearchCriteria,
	): Promise<ItemsResponseResult<T>> {
		if (!this._azdoRepositories || !this._azdoRepositories.length) {
			return {
				items: [],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};
		}

		const getTotalFetchedPages = () => this.totalFetchedPages.get(queryId) || 0;
		const setTotalFetchedPages = (numPages: number) => this.totalFetchedPages.set(queryId, numPages);

		for (const repository of this._azdoRepositories) {
			const remoteId = repository.remote.url.toString() + queryId;
			if (!this._repositoryPageInformation.get(remoteId)) {
				this._repositoryPageInformation.set(remoteId, {
					pullRequestPage: 0,
					hasMorePages: null,
				});
			}
		}

		let pagesFetched = 0;
		const itemData = { hasMorePages: false, items: [] };
		const addPage = (page: PullRequestModel[] | undefined) => {
			pagesFetched++;
			if (page) {
				itemData.items = itemData.items.concat(page as any);
				itemData.hasMorePages = false;
			}
		};

		const azdoRepositories = this._azdoRepositories.filter(repo => {
			const info = this._repositoryPageInformation.get(repo.remote.url.toString() + queryId);
			// If we are in case 1 or 3, don't filter out repos that are out of pages, as we will be querying from the start.
			return info && (options.fetchNextPage === false || info.hasMorePages !== false);
		});

		for (let i = 0; i < azdoRepositories.length; i++) {
			const azdoRepository = azdoRepositories[i];
			const remoteId = azdoRepository.remote.url.toString() + queryId;
			const pageInformation = this._repositoryPageInformation.get(remoteId)!;

			const fetchPage = async (_pageNumber: number): Promise<{ items: any[]; hasMorePages: boolean } | undefined> => {
				switch (pagedDataType) {
					case PagedDataType.PullRequest: {
						if (type === PRType.AllActive) {
							return { items: await azdoRepository.getAllActivePullRequests(), hasMorePages: false };
						} else if (type === PRType.CreatedByMe) {
							return {
								items: await azdoRepository.getPullRequests({
									creatorId: this.getCurrentUser()?.id,
									status: PullRequestStatus.Active,
								}),
								hasMorePages: false,
							};
						} else if (type === PRType.AssignedToMe) {
							return {
								items: await azdoRepository.getPullRequests({
									reviewerId: this.getCurrentUser()?.id,
									status: PullRequestStatus.Active,
								}),
								hasMorePages: false,
							};
						} else {
							return { items: await azdoRepository.getPullRequests(prSearchCriteria!), hasMorePages: false };
						}
					}
				}
			};

			if (options.fetchNextPage) {
				// Case 2. Fetch a single new page, and increment the global number of pages fetched for this query.
				pageInformation.pullRequestPage++;
				addPage((await fetchPage(pageInformation.pullRequestPage))?.items);
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
				pages.forEach(page => addPage(page?.items));
			}

			pageInformation.hasMorePages = itemData.hasMorePages;

			// Break early if
			// 1) we've received data AND
			// 2) either we're fetching just the next page (case 2)
			//    OR we're fetching all (cases 1&3), and we've fetched as far as we had previously (or further, in case 1).
			if (
				itemData.items.length &&
				(options.fetchNextPage === true || (options.fetchNextPage === false && pagesFetched >= getTotalFetchedPages()))
			) {
				if (getTotalFetchedPages() === 0) {
					// We're in case 1, manually set number of pages we looked through until we found first results.
					setTotalFetchedPages(pagesFetched);
				}

				return {
					items: itemData.items,
					hasMorePages: pageInformation.hasMorePages || false,
					hasUnsearchedRepositories: i < azdoRepositories.length - 1,
				};
			}
		}

		return {
			items: [],
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

	async getPullRequestTemplates(): Promise<vscode.Uri[]> {
		/**
		 * Places a PR template can be:
		 * - At the root, the docs folder, or the.github folder, named pull_request_template.md or PULL_REQUEST_TEMPLATE.md
		 * - At the same folder locations under a PULL_REQUEST_TEMPLATE folder with any name
		 */
		const templatesPattern1 = await vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri.path, '{pull_request_template,PULL_REQUEST_TEMPLATE}.md'),
		);
		const templatesPattern2 = await vscode.workspace.findFiles(
			new vscode.RelativePattern(
				this._repository.rootUri.path,
				'{docs,.github}/{pull_request_template,PULL_REQUEST_TEMPLATE}.md',
			),
		);

		const templatesPattern3 = await vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri.path, 'PULL_REQUEST_TEMPLATE/*.md'),
		);
		const templatesPattern4 = await vscode.workspace.findFiles(
			new vscode.RelativePattern(this._repository.rootUri.path, '{docs,.github}/PULL_REQUEST_TEMPLATE/*.md'),
		);

		return [...templatesPattern1, ...templatesPattern2, ...templatesPattern3, ...templatesPattern4];
	}

	async getPullRequestDefaults(): Promise<PullRequestDefaults> {
		if (!this.repository.state.HEAD) {
			throw new DetachedHeadError(this.repository);
		}
		const origin = await this.getOrigin();
		const meta = await origin.getMetadata();
		const parent = meta!.isFork!
			? await (await origin.azdo?.connection?.getGitApi())!.getRepository(meta!.parentRepository!.id!)
			: await (this.findRepo(byRemoteName('upstream')) || origin).getMetadata()!;

		return {
			owner: await origin.getAuthenticatedUserName(),
			repo: parent!.name!,
			base: parent!.defaultBranch!,
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

	async getOrigin(): Promise<AzdoRepository> {
		if (!this._azdoRepositories.length) {
			throw new NoGitHubReposError(this.repository);
		}

		const { upstreamRef } = this;
		if (upstreamRef) {
			// If our current branch has an upstream ref set, find its GitHubRepository.
			const upstream = this.findRepo(byRemoteName(upstreamRef.remote));

			// If the upstream wasn't listed in the remotes setting, create a GitHubRepository
			// object for it if is does point to GitHub.
			if (!upstream) {
				const remote = (await this.getAllGitHubRemotes()).find(r => r.remoteName === upstreamRef.remote);
				if (remote) {
					return new AzdoRepository(remote, this._credentialStore, this._fileReviewedStatusService, this._telemetry);
				}

				Logger.appendLine(`The remote '${upstreamRef.remote}' is not a GitHub repository.`);

				// No GitHubRepository? We currently won't try pushing elsewhere,
				// so fail.
				throw new BadUpstreamError(this.repository.state.HEAD!.name!, upstreamRef, 'is not a GitHub repo');
			}

			// Otherwise, we'll push upstream.
			return upstream;
		}

		// If no upstream is set, let's go digging.
		const [first, ...rest] = this._azdoRepositories;
		return !rest.length // Is there only one GitHub remote?
			? first // I GUESS THAT'S WHAT WE'RE GOING WITH, THEN.
			: // Otherwise, let's try...
			  this.findRepo(byRemoteName('origin')) || // by convention
					first; // out of raw desperation
	}

	findRepo(where: Predicate<AzdoRepository>): AzdoRepository | undefined {
		return this._azdoRepositories.filter(where)[0];
	}

	get upstreamRef(): UpstreamRef | undefined {
		const { HEAD } = this.repository.state;
		return HEAD && HEAD.upstream;
	}

	async createPullRequest(_params: GitPullRequest): Promise<PullRequestModel | undefined> {
		// TODO later
		return undefined;
		// try {
		// 	const repo = this._azdoRepositories.find(r => r.remote.repositoryName === params.repository?.name);
		// 	if (!repo) {
		// 		throw new Error(`No matching repository ${params.repository?.name} found for ${await this._azdoRepositories[0].getAuthenticatedUserName()}`);
		// 	}

		// 	await repo.ensure();

		// 	const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
		// 	if (!params.title) {
		// 		params.title = title;
		// 	}

		// 	if (!params.description) {
		// 		params.description = body;
		// 	}

		// 	// Create PR
		// 	const { data } = await repo.octokit.pulls.create(params);
		// 	const item = convertRESTPullRequestToRawPullRequest(data, repo);
		// 	const pullRequestModel = new PullRequestModel(this._telemetry, repo, repo.remote, item, true);

		// 	const branchNameSeparatorIndex = params.head.indexOf(':');
		// 	const branchName = params.head.slice(branchNameSeparatorIndex + 1);
		// 	await PullRequestGitHelper.associateBranchWithPullRequest(this._repository, pullRequestModel, branchName);

		// 	/* __GDPR__
		// 		"pr.create.success" : {
		// 			"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
		// 		}
		// 	*/
		// 	this._telemetry.sendTelemetryEvent('pr.create.success', { isDraft: (params.draft || '').toString() });
		// 	return pullRequestModel;
		// } catch (e) {
		// 	if (e.message.indexOf('No commits between ') > -1) {
		// 		// There are unpushed commits
		// 		if (this._repository.state.HEAD?.ahead) {
		// 			// Offer to push changes
		// 			const shouldPush = await vscode.window.showInformationMessage(`There are currently no commits between '${params.base}' and '${params.head}'. Do you want to push your local commits and try again?`, 'Yes', 'Cancel');
		// 			if (shouldPush === 'Yes') {
		// 				await this._repository.push();
		// 				return this.createPullRequest(params);
		// 			}

		// 			if (shouldPush === 'Cancel') {
		// 				return;
		// 			}
		// 		}

		// 		// There are uncommited changes
		// 		if (this._repository.state.workingTreeChanges.length || this._repository.state.indexChanges.length) {
		// 			const shouldCommit = await vscode.window.showInformationMessage(`There are currently no commits between '${params.base}' and '${params.head}'. Do you want to commit your changes and try again?`, 'Yes', 'Cancel');
		// 			if (shouldCommit === 'Yes') {
		// 				await vscode.commands.executeCommand('git.commit');
		// 				await this._repository.push();
		// 				return this.createPullRequest(params);
		// 			}

		// 			if (shouldCommit === 'Cancel') {
		// 				return;
		// 			}
		// 		}
		// 	}

		// 	Logger.appendLine(`GitHubRepository> Creating pull requests failed: ${e}`);

		// 	/* __GDPR__
		// 		"pr.create.failure" : {
		// 			"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
		// 			"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
		// 		}
		// 	*/
		// 	this._telemetry.sendTelemetryErrorEvent('pr.create.failure', {
		// 		isDraft: (params.draft || '').toString(),
		// 		message: formatError(e)
		// 	});
		// 	vscode.window.showWarningMessage(`Creating pull requests for '${params.head}' failed: ${formatError(e)}`);
		// }
	}

	getCurrentUser(): IAccount {
		return convertRESTIdentityToAccount(this._credentialStore.getAuthenticatedUser()!);
	}

	async mergePullRequest(
		_pullRequest: PullRequestModel,
		_title?: string,
		_description?: string,
		_method?: 'merge' | 'squash' | 'rebase',
	): Promise<any> {
		// TODO LATER
		// const activePRSHA = this.activePullRequest && this.activePullRequest.head && this.activePullRequest.head.sha;
		// const workingDirectorySHA = this.repository.state.HEAD && this.repository.state.HEAD.commit;
		// const mergingPRSHA = pullRequest.head && pullRequest.head.sha;
		// const workingDirectoryIsDirty = this.repository.state.workingTreeChanges.length > 0;
		// if (activePRSHA === mergingPRSHA) {
		// 	// We're on the branch of the pr being merged.
		// 	if (workingDirectorySHA !== mergingPRSHA) {
		// 		// We are looking at different commit than what will be merged
		// 		const { ahead } = this.repository.state.HEAD!;
		// 		if (ahead &&
		// 			await vscode.window.showWarningMessage(
		// 				`You have ${ahead} unpushed ${ahead > 1 ? 'commits' : 'commit'} on this PR branch.\n\nWould you like to proceed anyway?`,
		// 				{ modal: true },
		// 				'Yes') === undefined
		// 		) {
		// 			return {
		// 				merged: false,
		// 				message: 'unpushed changes'
		// 			};
		// 		}
		// 	}
		// 	if (workingDirectoryIsDirty) {
		// 		// We have made changes to the PR that are not committed
		// 		if (await vscode.window.showWarningMessage(
		// 			'You have uncommitted changes on this PR branch.\n\n Would you like to proceed anyway?', { modal: true }, 'Yes') === undefined) {
		// 			return {
		// 				merged: false,
		// 				message: 'uncommitted changes'
		// 			};
		// 		}
		// 	}
		// }
		// return await octokit.pulls.merge({
		// 	commit_message: description,
		// 	commit_title: title,
		// 	merge_method: method || vscode.workspace.getConfiguration('githubPullRequests').get<'merge' | 'squash' | 'rebase'>('defaultMergeMethod'),
		// 	owner: remote.owner,
		// 	repo: remote.repositoryName,
		// 	pull_number: pullRequest.number,
		// })
		// 	.then(x => {
		// 		/* __GDPR__
		// 			"azdopr.merge.success" : {}
		// 		*/
		// 		this._telemetry.sendTelemetryEvent('azdopr.merge.success');
		// 		return x.data;
		// 	}).catch(e => {
		// 		/* __GDPR__
		// 			"azdopr.merge.failure" : {
		// 				"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
		// 			}
		// 		*/
		// 		this._telemetry.sendTelemetryErrorEvent('azdopr.merge.failure', { message: formatError(e) });
		// 		throw e;
		// 	});
	}

	// async deleteBranch(pullRequest: PullRequestModel) {
	// 	await pullRequest.item.deleteBranch(pullRequest);
	// }

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
					  this.activePullRequest.getPullRequestId() === value.metadata.prNumber
					: false;

				if (!matchesActiveBranch) {
					actions.push({
						label: `${key}`,
						description: `${value.metadata!.repositoryName}/${value.metadata!.owner} #${value.metadata.prNumber}`,
						picked: false,
						metadata: value.metadata!,
					});
				}
			}
		});

		const results = await Promise.all(
			actions.map(async action => {
				const metadata = action.metadata;
				// tslint:disable-next-line: no-shadowed-variable
				const repo = this._azdoRepositories.find(
					repo =>
						repo.remote.owner.toLowerCase() === metadata!.owner.toLowerCase() &&
						repo.remote.repositoryName.toLowerCase() === metadata!.repositoryName.toLowerCase(),
				);

				if (!repo) {
					return action;
				}

				await repo.ensure();
				try {
					const prModel = await repo.getPullRequest(metadata!.prNumber);

					action.legacy = prModel?.item.status !== PullRequestStatus.Active;
				} catch {}

				return action;
			}),
		);

		results.forEach(result => {
			if (result.legacy) {
				result.picked = true;
			} else {
				result.description = result.description + ' is still Open';
			}
		});

		return results;
	}

	private async getRemoteDeletionItems() {
		// check if there are remotes that should be cleaned
		const newConfigs = await this.repository.getConfigs();
		const remoteInfos: Map<string, { branches: Set<string>; url?: string; createdForPullRequest?: boolean }> = new Map();

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

					const value = remoteInfos.get(remoteName);
					value!.branches.add(branchName);
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

		const remoteItems: (vscode.QuickPickItem & { remote: string })[] = [];

		remoteInfos.forEach((value, key) => {
			if (value.branches.size === 0) {
				let description = value.createdForPullRequest ? '' : 'Not created by GitHub Pull Request extension';
				if (value.url) {
					description = description ? description + ' ' + value.url : value.url;
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
			quickPick.placeholder = 'Choose local branches you want to delete permanently';
			quickPick.show();
			quickPick.busy = true;

			// Check local branches
			const results = await this.getBranchDeletionItems();
			quickPick.items = results;
			quickPick.selectedItems = results.filter(result => result.picked);
			quickPick.busy = false;

			let firstStep = true;
			quickPick.onDidAccept(async () => {
				if (firstStep) {
					const picks = quickPick.selectedItems;
					if (picks.length) {
						quickPick.busy = true;
						try {
							await Promise.all(
								picks.map(async pick => {
									await this.repository.deleteBranch(pick.label, true);
								}),
							);
							quickPick.busy = false;
						} catch (e) {
							quickPick.hide();
							vscode.window.showErrorMessage(`Deleting branches failed: ${e}`);
						}
					}

					firstStep = false;
					quickPick.busy = true;

					const remoteItems = await this.getRemoteDeletionItems();

					if (remoteItems) {
						quickPick.placeholder = 'Choose remotes you want to delete permanently';
						quickPick.busy = false;
						quickPick.items = remoteItems;
						quickPick.selectedItems = remoteItems.filter(item => item.picked);
					} else {
						quickPick.hide();
					}
				} else {
					// delete remotes
					const picks = quickPick.selectedItems;
					if (picks.length) {
						quickPick.busy = true;
						await Promise.all(
							picks.map(async pick => {
								await this.repository.removeRemote(pick.label);
							}),
						);
						quickPick.busy = false;
					}
					quickPick.hide();
				}
			});

			quickPick.onDidHide(() => {
				resolve();
			});
		});
	}

	async getPullRequestRepositoryDefaultBranch(pr: PullRequestModel): Promise<string> {
		const branch = await pr.azdoRepository.getDefaultBranch();
		return branch;
	}

	async getPullRequestRepositoryAccessAndMergeMethods(_pullRequest: PullRequestModel): Promise<RepoAccessAndMergeMethods> {
		return {
			hasWritePermission: true,
			mergeMethodsAvailability: {
				NoFastForward: true,
				Squash: true,
				Rebase: true,
				RebaseMerge: true,
			},
		};
	}

	//#region Git related APIs

	private async resolveItem(owner: string, repositoryName: string): Promise<AzdoRepository | undefined> {
		const githubRepo = this._azdoRepositories.find(repo => {
			const ret =
				repo.remote.owner.toLowerCase() === owner.toLowerCase() &&
				repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase();
			return ret;
		});

		return githubRepo;
	}

	async resolvePullRequest(
		owner: string,
		repositoryName: string,
		pullRequestNumber: number,
	): Promise<PullRequestModel | undefined> {
		const githubRepo = await this.resolveItem(owner, repositoryName);
		if (githubRepo) {
			return githubRepo.getPullRequest(pullRequestNumber);
		}
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

	async getMatchingPullRequestMetadataFromGitHub(): Promise<(PullRequestMetadata & { model: PullRequestModel }) | null> {
		if (
			!this.repository ||
			!this.repository.state.HEAD ||
			!this.repository.state.HEAD.name ||
			!this.repository.state.HEAD.upstream
		) {
			return null;
		}

		// Find the github repo that matches the upstream
		for (const repo of this.azdoRepositories) {
			if (repo.remote.remoteName === this.repository.state.HEAD.upstream.remote) {
				const matchingPullRequest = await repo.getPullRequestForBranch(this.repository.state.HEAD.upstream.name);
				if (matchingPullRequest && matchingPullRequest.length > 0) {
					return {
						owner: repo.remote.owner,
						repositoryName: repo.remote.repositoryName,
						prNumber: matchingPullRequest[0].getPullRequestId(),
						model: matchingPullRequest[0],
					};
				}
				break;
			}
		}
		return null;
	}

	async checkoutExistingPullRequestBranch(pullRequest: PullRequestModel): Promise<boolean> {
		return await PullRequestGitHelper.checkoutExistingPullRequestBranch(this.repository, pullRequest);
	}

	async getBranchNameForPullRequest(pullRequest: PullRequestModel) {
		return await PullRequestGitHelper.getBranchNRemoteForPullRequest(this.repository, pullRequest);
	}

	async fetchAndCheckout(pullRequest: PullRequestModel): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, this._allGitHubRemotes, pullRequest);
	}

	async checkout(branchName: string): Promise<void> {
		return this.repository.checkout(branchName);
	}

	public async checkoutDefaultBranch(branch?: string): Promise<void> {
		try {
			if (!branch) {
				branch =
					(await this._activePullRequest?.azdoRepository?.getDefaultBranch()) ??
					(await this.azdoRepositories?.[0].getDefaultBranch()) ??
					'main';
			}
			const branchObj = await this.repository.getBranch(branch);

			if (branchObj.upstream && branch === branchObj.upstream.name) {
				await this.repository.checkout(branch);
			} else {
				await vscode.commands.executeCommand('git.checkout');
			}
		} catch (e) {
			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage(
						'Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches',
					);
					return;
				}
			}

			vscode.window.showErrorMessage(`Exiting failed: ${e}`);
		}
	}

	createAzdoRepository(
		remote: Remote,
		credentialStore: CredentialStore,
		fileReviewedStatusService: FileReviewedStatusService,
	): AzdoRepository {
		return new AzdoRepository(remote, credentialStore, fileReviewedStatusService, this._telemetry);
	}

	async findUpstreamForItem(item: {
		remote: Remote;
		githubRepository: AzdoRepository;
	}): Promise<{ needsFork: boolean; upstream?: AzdoRepository; remote?: Remote }> {
		let upstream: AzdoRepository | undefined;
		let existingForkRemote: Remote | undefined;
		for (const azdoRepo of this.azdoRepositories) {
			if (
				!upstream &&
				azdoRepo.remote.owner === item.remote.owner &&
				azdoRepo.remote.repositoryName === item.remote.repositoryName
			) {
				upstream = azdoRepo;
				continue;
			}
			const repo = await azdoRepo.getMetadata();
			const forkDetails = {
				isFork: repo?.isFork ?? false,
				parent: {
					name: repo?.parentRepository?.name,
				},
			};
			if (forkDetails && forkDetails.isFork && forkDetails.parent.name === item.remote.repositoryName) {
				existingForkRemote = azdoRepo.remote;
				break;
			}
		}
		return { needsFork: false, upstream, remote: existingForkRemote };
	}

	dispose() {
		this._subs.forEach(sub => sub.dispose());
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

const byRemoteName = (name: string): Predicate<AzdoRepository> => ({ remote: { remoteName } }) => remoteName === name;

export const titleAndBodyFrom = (message: string): { title: string; body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1 ? message : message.substr(0, idxLineBreak),

		body: idxLineBreak === -1 ? '' : message.slice(idxLineBreak + 1).trim(),
	};
};
