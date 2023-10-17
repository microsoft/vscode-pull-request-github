/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChooseBaseRemoteAndBranchResult, ChooseCompareRemoteAndBranchResult, ChooseRemoteAndBranchArgs, CreateParamsNew, CreatePullRequestNew, RemoteInfo } from '../../common/views';
import type { Branch, Ref } from '../api/api';
import { GitHubServerType } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { GitHubRemote } from '../common/remote';
import {
	ASSIGN_TO,
	DEFAULT_CREATE_OPTION,
	PR_SETTINGS_NAMESPACE,
	PULL_REQUEST_DESCRIPTION,
	PUSH_BRANCH
} from '../common/settingKeys';
import { asPromise, compareIgnoreCase, formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { PREVIOUS_CREATE_METHOD } from '../extensionState';
import { CreatePullRequestDataModel } from '../view/createPullRequestDataModel';
import {
	byRemoteName,
	DetachedHeadError,
	FolderRepositoryManager,
	PullRequestDefaults,
	titleAndBodyFrom,
} from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { IAccount, ILabel, IMilestone, isTeam, ITeam, MergeMethod, RepoAccessAndMergeMethods } from './interface';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { getAssigneesQuickPickItems, getLabelOptions, getMilestoneFromQuickPick, reviewersQuickPick } from './quickPicks';
import { ISSUE_EXPRESSION, parseIssueExpressionOutput, variableSubstitution } from './utils';

const ISSUE_CLOSING_KEYWORDS = new RegExp('closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve\s$', 'i'); // https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword

export class CreatePullRequestViewProviderNew extends WebviewViewBase implements vscode.WebviewViewProvider, vscode.Disposable {
	private static readonly ID = 'CreatePullRequestViewProvider';
	public readonly viewType = 'github:createPullRequestWebview';

	private _onDone = new vscode.EventEmitter<PullRequestModel | undefined>();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	private _onDidChangeBaseRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeBaseRemote: vscode.Event<RemoteInfo> = this._onDidChangeBaseRemote.event;

	private _onDidChangeBaseBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeBaseBranch: vscode.Event<string> = this._onDidChangeBaseBranch.event;

	private _onDidChangeCompareRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeCompareRemote: vscode.Event<RemoteInfo> = this._onDidChangeCompareRemote.event;

	private _onDidChangeCompareBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeCompareBranch: vscode.Event<string> = this._onDidChangeCompareBranch.event;

	private _compareBranch: string;
	private _baseBranch: string;
	private _baseRemote: RemoteInfo;

	private _firstLoad: boolean = true;

	constructor(
		private readonly model: CreatePullRequestDataModel,
		extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _pullRequestDefaults: PullRequestDefaults,
		compareBranch: Branch,
	) {
		super(extensionUri);

		this._defaultCompareBranch = compareBranch;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		super.resolveWebviewView(webviewView, _context, _token);
		webviewView.webview.html = this._getHtmlForWebview();

		if (this._firstLoad) {
			this._firstLoad = false;
			// Reset any stored state.
			return this.initializeParams(true);
		} else {
			return this.initializeParams();
		}
	}

	private _defaultCompareBranch: Branch;
	get defaultCompareBranch() {
		return this._defaultCompareBranch;
	}

	set defaultCompareBranch(compareBranch: Branch | undefined) {
		const branchChanged = compareBranch && (compareBranch.name !== this._defaultCompareBranch.name);
		const branchRemoteChanged = compareBranch && (compareBranch.upstream?.remote !== this._defaultCompareBranch.upstream?.remote);
		const commitChanged = compareBranch && (compareBranch.commit !== this._defaultCompareBranch.commit);
		if (branchChanged || branchRemoteChanged || commitChanged) {
			this._defaultCompareBranch = compareBranch!;
			this.changeBranch(compareBranch!.name!, false).then(titleAndDescription => {
				const params: Partial<CreateParamsNew> = {
					defaultTitle: titleAndDescription.title,
					defaultDescription: titleAndDescription.description,
					compareBranch: compareBranch?.name,
					defaultCompareBranch: compareBranch?.name
				};
				if (!branchRemoteChanged) {
					return this._postMessage({
						command: 'pr.initialize',
						params,
					});
				}
			});

			if (branchChanged) {
				this._onDidChangeCompareBranch.fire(this._defaultCompareBranch.name!);
			}
		}
	}

	public show(compareBranch?: Branch): void {
		if (compareBranch) {
			this.defaultCompareBranch = compareBranch;
		}

		super.show();
	}

	private async getTotalGitHubCommits(compareBranch: Branch, baseBranchName: string): Promise<number | undefined> {
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);

		if (compareBranch.upstream) {
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(compareBranch.upstream.remote));

			if (headRepo) {
				const headBranch = `${headRepo.remote.owner}:${compareBranch.name ?? ''}`;
				const baseBranch = `${this._pullRequestDefaults.owner}:${baseBranchName}`;
				const compareResult = await origin.compareCommits(baseBranch, headBranch);

				return compareResult?.total_commits;
			}
		}

		return undefined;
	}

	private async getTitleAndDescription(compareBranch: Branch, baseBranch: string): Promise<{ title: string, description: string }> {
		let title: string = '';
		let description: string = '';

		// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name, as long as it is not the default branch.
		// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
		// compare branch if it has a GitHub remote.
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);
		const useTemplate =
			vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(PULL_REQUEST_DESCRIPTION) ===
			'template';

		let useBranchName = this._pullRequestDefaults.base === compareBranch.name;
		Logger.debug(`Compare branch name: ${compareBranch.name}, Base branch name: ${this._pullRequestDefaults.base}`, CreatePullRequestViewProviderNew.ID);
		try {
			const name = compareBranch.name;
			const [totalCommits, lastCommit, pullRequestTemplate] = await Promise.all([
				this.getTotalGitHubCommits(compareBranch, baseBranch),
				name ? titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(name)) : undefined,
				useTemplate ? await this.getPullRequestTemplate() : undefined
			]);

			Logger.debug(`Total commits: ${totalCommits}`, CreatePullRequestViewProviderNew.ID);
			if (totalCommits === undefined) {
				// There is no upstream branch. Use the last commit as the title and description.
				useBranchName = false;
			} else if (totalCommits > 1) {
				const defaultBranch = await origin.getDefaultBranch();
				useBranchName = defaultBranch !== compareBranch.name;
			}

			// Set title
			if (useBranchName && name) {
				title = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
			} else if (name && lastCommit) {
				title = lastCommit.title;
			}

			// Set description
			if (pullRequestTemplate && lastCommit?.body) {
				description = `${lastCommit.body}\n\n${pullRequestTemplate}`;
			} else if (pullRequestTemplate) {
				description = pullRequestTemplate;
			} else if (lastCommit?.body && (this._pullRequestDefaults.base !== compareBranch.name)) {
				description = lastCommit.body;
			}

			// If the description is empty, check to see if the title of the PR contains something that looks like an issue
			if (!description) {
				const issueExpMatch = title.match(ISSUE_EXPRESSION);
				const match = parseIssueExpressionOutput(issueExpMatch);
				if (match?.issueNumber && !match.name && !match.owner) {
					description = `#${match.issueNumber}`;
					const prefix = title.substr(0, title.indexOf(issueExpMatch![0]));

					const keyWordMatch = prefix.match(ISSUE_CLOSING_KEYWORDS);
					if (keyWordMatch) {
						description = `${keyWordMatch[0]} ${description}`;
					}
				}
			}
		} catch (e) {
			// Ignore and fall back to commit message
			Logger.debug(`Error while getting total commits: ${e}`, CreatePullRequestViewProviderNew.ID);
		}
		return { title, description };
	}

	private async getPullRequestTemplate(): Promise<string | undefined> {
		const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
		if (templateUris[0]) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
				return new TextDecoder('utf-8').decode(templateContent);
			} catch (e) {
				Logger.warn(`Reading pull request template failed: ${e}`);
				return undefined;
			}
		}

		return undefined;
	}

	private async getMergeConfiguration(owner: string, name: string, refetch: boolean = false): Promise<RepoAccessAndMergeMethods> {
		const repo = await this._folderRepositoryManager.createGitHubRepositoryFromOwnerName(owner, name);
		return repo.getRepoAccessAndMergeMethods(refetch);
	}

	private initializeWhenVisibleDisposable: vscode.Disposable | undefined;
	public async initializeParams(reset: boolean = false): Promise<void> {
		if (this._view?.visible === false && this.initializeWhenVisibleDisposable === undefined) {
			this.initializeWhenVisibleDisposable = this._view?.onDidChangeVisibility(() => {
				this.initializeWhenVisibleDisposable?.dispose();
				this.initializeWhenVisibleDisposable = undefined;
				void this.initializeParams();
			});
			return;
		}

		if (reset) {
			// First clear all state ASAP
			this._postMessage({ command: 'reset' });
		}
	}

	private async doInitializeParams(): Promise<CreateParamsNew> {
		if (!this.defaultCompareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultCompareBranch = this.defaultCompareBranch.name ?? '';
		const [detectedBaseMetadata, remotes] = await Promise.all([
			PullRequestGitHelper.getMatchingBaseBranchMetadataForBranch(this._folderRepositoryManager.repository, defaultCompareBranch),
			this._folderRepositoryManager.getGitHubRemotes()]);

		const defaultBaseRemote: RemoteInfo = {
			owner: detectedBaseMetadata?.owner ?? this._pullRequestDefaults.owner,
			repositoryName: detectedBaseMetadata?.repositoryName ?? this._pullRequestDefaults.repo,
		};
		if (defaultBaseRemote.owner !== this._pullRequestDefaults.owner || defaultBaseRemote.repositoryName !== this._pullRequestDefaults.repo) {
			this._onDidChangeBaseRemote.fire(defaultBaseRemote);
		}

		const defaultOrigin = await this._folderRepositoryManager.getOrigin(this.defaultCompareBranch);
		const defaultCompareRemote: RemoteInfo = {
			owner: defaultOrigin.remote.owner,
			repositoryName: defaultOrigin.remote.repositoryName,
		};

		const defaultBaseBranch = detectedBaseMetadata?.branch ?? this._pullRequestDefaults.base;
		if (defaultBaseBranch !== this._pullRequestDefaults.base) {
			this._onDidChangeBaseBranch.fire(defaultBaseBranch);
		}

		const [defaultTitleAndDescription, mergeConfiguration, viewerPermission] = await Promise.all([
			this.getTitleAndDescription(this.defaultCompareBranch, defaultBaseBranch),
			this.getMergeConfiguration(defaultBaseRemote.owner, defaultBaseRemote.repositoryName),
			await defaultOrigin.getViewerPermission()
		]);

		const defaultCreateOption = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'lastUsed' | 'create' | 'createDraft' | 'createAutoMerge'>(DEFAULT_CREATE_OPTION, 'lastUsed');
		const lastCreateMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } | undefined = this._folderRepositoryManager.context.workspaceState.get<{ autoMerge: boolean, mergeMethod: MergeMethod, isDraft } | undefined>(PREVIOUS_CREATE_METHOD, undefined);
		const repoMergeMethod = getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability);

		// default values are for 'create'
		let defaultMergeMethod: MergeMethod = repoMergeMethod;
		let isDraftDefault: boolean = false;
		let autoMergeDefault: boolean = false;
		defaultMergeMethod = (defaultCreateOption === 'lastUsed' && lastCreateMethod?.mergeMethod) ? lastCreateMethod?.mergeMethod : repoMergeMethod;

		if (defaultCreateOption === 'lastUsed') {
			defaultMergeMethod = lastCreateMethod?.mergeMethod ?? repoMergeMethod;
			isDraftDefault = !!lastCreateMethod?.isDraft;
			autoMergeDefault = mergeConfiguration.viewerCanAutoMerge && !!lastCreateMethod?.autoMerge;
		} else if (defaultCreateOption === 'createDraft') {
			isDraftDefault = true;
		} else if (defaultCreateOption === 'createAutoMerge') {
			autoMergeDefault = mergeConfiguration.viewerCanAutoMerge;
		}
		commands.setContext(contexts.CREATE_PR_PERMISSIONS, viewerPermission);

		const params: CreateParamsNew = {
			defaultBaseRemote,
			defaultBaseBranch,
			defaultCompareRemote,
			defaultCompareBranch,
			defaultTitle: defaultTitleAndDescription.title,
			defaultDescription: defaultTitleAndDescription.description,
			defaultMergeMethod,
			remoteCount: remotes.length,
			allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
			mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
			autoMergeDefault,
			createError: '',
			labels: this.labels,
			isDraftDefault,
			isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
			canGenerateTitleAndDescription: this._folderRepositoryManager.getTitleAndDescriptionProvider() !== undefined,
			creating: false
		};

		Logger.appendLine(`Initializing "create" view: ${JSON.stringify(params)}`, CreatePullRequestViewProviderNew.ID);

		this._compareBranch = this.defaultCompareBranch.name ?? '';
		this._baseBranch = defaultBaseBranch;
		this._baseRemote = defaultBaseRemote;

		this._postMessage({
			command: 'pr.initialize',
			params,
		});
		return params;
	}


	private async remotePicks(isBase: boolean): Promise<(vscode.QuickPickItem & { remote?: RemoteInfo })[]> {
		const remotes = isBase ? await this._folderRepositoryManager.getActiveGitHubRemotes(await this._folderRepositoryManager.getGitHubRemotes()) : this._folderRepositoryManager.gitHubRepositories.map(repo => repo.remote);
		return remotes.map(remote => {
			return {
				iconPath: new vscode.ThemeIcon('repo'),
				label: `${remote.owner}/${remote.repositoryName}`,
				remote: {
					owner: remote.owner,
					repositoryName: remote.repositoryName,
				}
			};
		});
	}

	private async branchPicks(githubRepository: GitHubRepository, changeRepoMessage: string, isBase: boolean): Promise<(vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })[]> {
		let branches: (string | Ref)[];
		if (isBase) {
			// For the base, we only want to show branches from GitHub.
			branches = await githubRepository.listBranches(githubRepository.remote.owner, githubRepository.remote.repositoryName);
		} else {
			// For the compare, we only want to show local branches.
			branches = (await this._folderRepositoryManager.repository.getBranches({ remote: false })).filter(branch => branch.name);
		}
		// TODO: @alexr00 - Add sorting so that the most likely to be used branch (ex main or release if base) is at the top of the list.
		const branchPicks: (vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })[] = branches.map(branch => {
			const branchName = typeof branch === 'string' ? branch : branch.name!;
			const pick: (vscode.QuickPickItem & { remote: RemoteInfo, branch: string }) = {
				iconPath: new vscode.ThemeIcon('git-branch'),
				label: branchName,
				remote: {
					owner: githubRepository.remote.owner,
					repositoryName: githubRepository.remote.repositoryName
				},
				branch: branchName
			};
			return pick;
		});
		branchPicks.unshift({
			kind: vscode.QuickPickItemKind.Separator,
			label: `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`
		});
		branchPicks.unshift({
			iconPath: new vscode.ThemeIcon('repo'),
			label: changeRepoMessage
		});
		return branchPicks;
	}

	private async processRemoteAndBranchResult(githubRepository: GitHubRepository, result: { remote: RemoteInfo, branch: string }, isBase: boolean) {
		const [defaultBranch, viewerPermission] = await Promise.all([githubRepository.getDefaultBranch(), githubRepository.getViewerPermission()]);

		commands.setContext(contexts.CREATE_PR_PERMISSIONS, viewerPermission);
		let chooseResult: ChooseBaseRemoteAndBranchResult | ChooseCompareRemoteAndBranchResult;
		if (isBase) {
			const baseRemoteChanged = this._baseRemote !== result.remote;
			const baseBranchChanged = baseRemoteChanged || this._baseBranch !== result.branch;
			this._baseBranch = result.branch;
			this._baseRemote = result.remote;
			const compareBranch = await this._folderRepositoryManager.repository.getBranch(this._compareBranch);
			const [mergeConfiguration, titleAndDescription] = await Promise.all([this.getMergeConfiguration(result.remote.owner, result.remote.repositoryName), this.getTitleAndDescription(compareBranch, this._baseBranch)]);
			let autoMergeDefault = false;
			if (mergeConfiguration.viewerCanAutoMerge) {
				const defaultCreateOption = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'lastUsed' | 'create' | 'createDraft' | 'createAutoMerge'>(DEFAULT_CREATE_OPTION, 'lastUsed');
				const lastCreateMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } | undefined = this._folderRepositoryManager.context.workspaceState.get<{ autoMerge: boolean, mergeMethod: MergeMethod, isDraft } | undefined>(PREVIOUS_CREATE_METHOD, undefined);
				autoMergeDefault = (defaultCreateOption === 'lastUsed' && lastCreateMethod?.autoMerge) || (defaultCreateOption === 'createAutoMerge');
			}

			chooseResult = {
				baseRemote: result.remote,
				baseBranch: result.branch,
				defaultBaseBranch: defaultBranch,
				defaultMergeMethod: getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability),
				allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
				mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
				autoMergeDefault,
				defaultTitle: titleAndDescription.title,
				defaultDescription: titleAndDescription.description
			};
			if (baseRemoteChanged) {
				/* __GDPR__
				"pr.create.changedBaseRemote" : {}
				*/
				this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedBaseRemote');
				this._onDidChangeBaseRemote.fire(this._baseRemote);
			}
			if (baseBranchChanged) {
				/* __GDPR__
				"pr.create.changedBaseBranch" : {}
				*/
				this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedBaseBranch');
				this._onDidChangeBaseBranch.fire(this._baseBranch);
			}
		} else {
			this._compareBranch = result.branch;
			chooseResult = {
				compareRemote: result.remote,
				compareBranch: result.branch,
				defaultCompareBranch: defaultBranch
			};
			/* __GDPR__
			"pr.create.changedCompare" : {}
			*/
			this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedCompare');
			this._onDidChangeCompareRemote.fire(result.remote);
			this._onDidChangeCompareBranch.fire(this._compareBranch);
		}
		return chooseResult;
	}

	private async changeRemoteAndBranch(message: IRequestMessage<ChooseRemoteAndBranchArgs>, isBase: boolean): Promise<void> {
		const quickPick = vscode.window.createQuickPick<(vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })>();
		let githubRepository = this._folderRepositoryManager.findRepo(
			repo => message.args.currentRemote?.owner === repo.remote.owner && message.args.currentRemote.repositoryName === repo.remote.repositoryName,
		);

		const chooseDifferentRemote = vscode.l10n.t('Change Repository...');
		const remotePlaceholder = vscode.l10n.t('Choose a remote');
		const branchPlaceholder = isBase ? vscode.l10n.t('Choose a base branch') : vscode.l10n.t('Choose a branch to merge');
		const repositoryPlaceholder = isBase ? vscode.l10n.t('Choose a base repository') : vscode.l10n.t('Choose a repository to merge from');

		quickPick.placeholder = githubRepository ? branchPlaceholder : remotePlaceholder;
		quickPick.show();
		quickPick.busy = true;
		quickPick.items = githubRepository ? await this.branchPicks(githubRepository, chooseDifferentRemote, isBase) : await this.remotePicks(isBase);
		const activeItem = message.args.currentBranch ? quickPick.items.find(item => item.branch === message.args.currentBranch) : undefined;
		quickPick.activeItems = activeItem ? [activeItem] : [];
		quickPick.busy = false;
		const remoteAndBranch: Promise<{ remote: RemoteInfo, branch: string } | undefined> = new Promise((resolve) => {
			quickPick.onDidAccept(async () => {
				if (quickPick.selectedItems.length === 0) {
					return;
				}
				const selectedPick = quickPick.selectedItems[0];
				if (selectedPick.label === chooseDifferentRemote) {
					quickPick.busy = true;
					quickPick.items = await this.remotePicks(isBase);
					quickPick.busy = false;
					quickPick.placeholder = githubRepository ? repositoryPlaceholder : remotePlaceholder;
				} else if ((selectedPick.branch === undefined) && selectedPick.remote) {
					const selectedRemote = selectedPick as vscode.QuickPickItem & { remote: RemoteInfo };
					quickPick.busy = true;
					githubRepository = this._folderRepositoryManager.findRepo(repo => repo.remote.owner === selectedRemote.remote.owner && repo.remote.repositoryName === selectedRemote.remote.repositoryName)!;
					quickPick.items = await this.branchPicks(githubRepository, chooseDifferentRemote, isBase);
					quickPick.placeholder = branchPlaceholder;
					quickPick.busy = false;
				} else if (selectedPick.branch && selectedPick.remote) {
					const selectedBranch = selectedPick as vscode.QuickPickItem & { remote: RemoteInfo, branch: string };
					resolve({ remote: selectedBranch.remote, branch: selectedBranch.branch });
				}
			});
		});
		const hidePromise = new Promise<void>((resolve) => quickPick.onDidHide(() => resolve()));
		const result = await Promise.race([remoteAndBranch, hidePromise]);
		if (!result || !githubRepository) {
			quickPick.hide();
			quickPick.dispose();
			return;
		}

		quickPick.busy = true;
		const chooseResult = await this.processRemoteAndBranchResult(githubRepository, result, isBase);

		quickPick.hide();
		quickPick.dispose();
		return this._replyMessage(message, chooseResult);
	}

	private async autoAssign(pr: PullRequestModel): Promise<void> {
		const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string | undefined>(ASSIGN_TO);
		if (!configuration) {
			return;
		}
		const resolved = await variableSubstitution(configuration, pr, undefined, (await this._folderRepositoryManager.getCurrentUser(pr.githubRepository))?.login);
		if (!resolved) {
			return;
		}
		try {
			await pr.addAssignees([resolved]);
		} catch (e) {
			Logger.error(`Unable to assign pull request to user ${resolved}.`);
		}
	}

	private async enableAutoMerge(pr: PullRequestModel, autoMerge: boolean, automergeMethod: MergeMethod | undefined): Promise<void> {
		if (autoMerge && automergeMethod) {
			return pr.enableAutoMerge(automergeMethod);
		}
	}

	private async setLabels(pr: PullRequestModel, labels: ILabel[]): Promise<void> {
		if (labels.length > 0) {
			await pr.setLabels(labels.map(label => label.name));
		}
	}

	private async setAssignees(pr: PullRequestModel, assignees: IAccount[]): Promise<void> {
		if (assignees.length) {
			await pr.addAssignees(assignees.map(assignee => assignee.login));
		} else {
			await this.autoAssign(pr);
		}
	}

	private async setReviewers(pr: PullRequestModel, reviewers: (IAccount | ITeam)[]): Promise<void> {
		if (reviewers.length) {
			const users: string[] = [];
			const teams: string[] = [];
			for (const reviewer of reviewers) {
				if (isTeam(reviewer)) {
					teams.push(reviewer.id);
				} else {
					users.push(reviewer.id);
				}
			}
			await pr.requestReview(users, teams);
		}
	}

	private setMilestone(pr: PullRequestModel, milestone: IMilestone | undefined): void {
		if (milestone) {
			pr.updateMilestone(milestone.id);
		}
	}

	private async getRemote(): Promise<GitHubRemote> {
		return (await this._folderRepositoryManager.getGitHubRemotes()).find(remote => compareIgnoreCase(remote.owner, this._baseRemote.owner) === 0 && compareIgnoreCase(remote.repositoryName, this._baseRemote.repositoryName) === 0)!;
	}

	private milestone: IMilestone | undefined;
	public async addMilestone(): Promise<void> {
		const remote = await this.getRemote();
		const repo = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.remoteName === remote.remoteName)!;

		return getMilestoneFromQuickPick(this._folderRepositoryManager, repo, this.milestone, (milestone) => {
			this.milestone = milestone;
			return this._postMessage({
				command: 'set-milestone',
				params: { milestone: this.milestone }
			});
		});
	}

	private reviewers: (IAccount | ITeam)[] = [];
	public async addReviewers(): Promise<void> {
		let quickPick: vscode.QuickPick<vscode.QuickPickItem & {
			user?: IAccount | ITeam | undefined;
		}> | undefined;
		const remote = await this.getRemote();
		try {
			const repo = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.remoteName === remote.remoteName)!;
			const [metadata, author, teamsCount] = await Promise.all([repo?.getMetadata(), this._folderRepositoryManager.getCurrentUser(), this._folderRepositoryManager.getOrgTeamsCount(repo)]);
			quickPick = await reviewersQuickPick(this._folderRepositoryManager, remote.remoteName, !!metadata?.organization, teamsCount, author, this.reviewers.map(reviewer => { return { reviewer, state: 'REQUESTED' }; }), []);
			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick!.selectedItems.filter(item => item.user) as (vscode.QuickPickItem & { user: IAccount | ITeam })[] | undefined;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allReviewers = await Promise.race<(vscode.QuickPickItem & { user: IAccount | ITeam })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;

			if (allReviewers) {
				this.reviewers = allReviewers.map(item => item.user);
				this._postMessage({
					command: 'set-reviewers',
					params: { reviewers: this.reviewers }
				});
			}
		} catch (e) {
			Logger.error(formatError(e));
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick?.hide();
			quickPick?.dispose();
		}
	}

	private assignees: IAccount[] = [];
	public async addAssignees(): Promise<void> {
		const remote = await this.getRemote();
		const assigneesToAdd = await vscode.window.showQuickPick(getAssigneesQuickPickItems(this._folderRepositoryManager, remote.remoteName, this.assignees),
			{ canPickMany: true, placeHolder: vscode.l10n.t('Add assignees') });
		if (assigneesToAdd) {
			const addedAssignees = assigneesToAdd.map(assignee => assignee.user).filter<IAccount>((assignee): assignee is IAccount => !!assignee);
			this.assignees = addedAssignees;
			this._postMessage({
				command: 'set-assignees',
				params: { assignees: this.assignees }
			});
		}
	}

	private labels: ILabel[] = [];
	public async addLabels(): Promise<void> {
		let newLabels: ILabel[] = [];

		const labelsToAdd = await vscode.window.showQuickPick(
			getLabelOptions(this._folderRepositoryManager, this.labels, this._baseRemote).then(options => {
				newLabels = options.newLabels;
				return options.labelPicks;
			}) as Promise<vscode.QuickPickItem[]>,
			{ canPickMany: true, placeHolder: vscode.l10n.t('Apply labels') },
		);

		if (labelsToAdd) {
			const addedLabels: ILabel[] = labelsToAdd.map(label => newLabels.find(l => l.name === label.label)!);
			this.labels = addedLabels;
			this._postMessage({
				command: 'set-labels',
				params: { labels: this.labels }
			});
		}
	}

	private async removeLabel(message: IRequestMessage<{ label: ILabel }>,): Promise<void> {
		const { label } = message.args;
		if (!label)
			return;

		const previousLabelsLength = this.labels.length;
		this.labels = this.labels.filter(l => l.name !== label.name);
		if (previousLabelsLength === this.labels.length)
			return;

		this._postMessage({
			command: 'set-labels',
			params: { labels: this.labels }
		});
	}

	private async generateTitleAndDescription(message: IRequestMessage<void>): Promise<void> {
		let commits: string[];
		let patches: string[];
		if (this.model.compareHasUpstream) {
			commits = (await this.model.gitHubCommits()).map(commit => commit.commit.message);
			patches = (await this.model.gitHubFiles()).map(file => file.patch ?? '');
		} else {
			commits = (await this.model.gitCommits()).map(commit => commit.message);
			patches = await Promise.all((await this.model.gitFiles()).map(async (file) => {
				return this._folderRepositoryManager.repository.diffBetween(this.model.baseBranch, this.model.getCompareBranch(), file.uri.fsPath);
			}));
		}
		const generated = await this._folderRepositoryManager.getTitleAndDescriptionProvider()?.provideTitleAndDescription(commits, patches);

		return this._replyMessage(message, { title: generated?.title, description: generated?.description });
	}

	private async pushUpstream(compareOwner: string, compareRepositoryName: string, compareBranchName: string): Promise<{ compareUpstream: GitHubRemote, repo: GitHubRepository | undefined } | undefined> {
		let createdPushRemote: GitHubRemote | undefined;
		const pushRemote = this._folderRepositoryManager.repository.state.remotes.find(localRemote => {
			if (!localRemote.pushUrl) {
				return false;
			}
			const testRemote = new GitHubRemote(localRemote.name, localRemote.pushUrl, new Protocol(localRemote.pushUrl), GitHubServerType.GitHubDotCom);
			if ((testRemote.owner.toLowerCase() === compareOwner.toLowerCase()) && (testRemote.repositoryName.toLowerCase() === compareRepositoryName.toLowerCase())) {
				createdPushRemote = testRemote;
				return true;
			}
			return false;
		});

		if (pushRemote && createdPushRemote) {
			Logger.appendLine(`Found push remote ${pushRemote.name} for ${compareOwner}/${compareRepositoryName} and branch ${compareBranchName}`, CreatePullRequestViewProviderNew.ID);
			await this._folderRepositoryManager.repository.push(pushRemote.name, compareBranchName, true);
			await this._folderRepositoryManager.repository.status();
			return { compareUpstream: createdPushRemote, repo: this._folderRepositoryManager.findRepo(byRemoteName(createdPushRemote.remoteName)) };
		}
	}

	public async createFromCommand(isDraft: boolean, autoMerge: boolean, autoMergeMethod: MergeMethod | undefined) {
		const params: Partial<CreateParamsNew> = {
			isDraft,
			autoMerge,
			autoMergeMethod,
			creating: true
		};
		return this._postMessage({
			command: 'create',
			params
		});
	}

	private async create(message: IRequestMessage<CreatePullRequestNew>): Promise<void> {
		Logger.debug(`Creating pull request with args ${JSON.stringify(message.args)}`, CreatePullRequestViewProviderNew.ID);

		// Save create method
		const createMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } = { autoMerge: message.args.autoMerge, mergeMethod: message.args.autoMergeMethod, isDraft: message.args.draft };
		this._folderRepositoryManager.context.workspaceState.update(PREVIOUS_CREATE_METHOD, createMethod);

		const postCreate = (createdPR: PullRequestModel) => {
			return Promise.all([
				this.setLabels(createdPR, message.args.labels),
				this.enableAutoMerge(createdPR, message.args.autoMerge, message.args.autoMergeMethod),
				this.setAssignees(createdPR, message.args.assignees),
				this.setReviewers(createdPR, message.args.reviewers),
				this.setMilestone(createdPR, message.args.milestone)]);
		};

		vscode.window.withProgress({ location: { viewId: 'github:createPullRequestWebview' } }, () => {
			return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async progress => {
				let totalIncrement = 0;
				progress.report({ message: vscode.l10n.t('Checking for upstream branch'), increment: totalIncrement });
				let createdPR: PullRequestModel | undefined = undefined;
				try {
					const compareOwner = message.args.compareOwner;
					const compareRepositoryName = message.args.compareRepo;
					const compareBranchName = message.args.compareBranch;
					const compareGithubRemoteName = `${compareOwner}/${compareRepositoryName}`;
					const compareBranch = await this._folderRepositoryManager.repository.getBranch(compareBranchName);
					let headRepo = compareBranch.upstream ? this._folderRepositoryManager.findRepo((githubRepo) => {
						return (githubRepo.remote.owner === compareOwner) && (githubRepo.remote.repositoryName === compareRepositoryName);
					}) : undefined;
					let existingCompareUpstream = headRepo?.remote;

					if (!existingCompareUpstream
						|| (existingCompareUpstream.owner !== compareOwner)
						|| (existingCompareUpstream.repositoryName !== compareRepositoryName)) {

						// We assume this happens only when the compare branch is based on the current branch.
						const alwaysPublish = vscode.l10n.t('Always Publish Branch');
						const publish = vscode.l10n.t('Publish Branch');
						const pushBranchSetting =
							vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get(PUSH_BRANCH) === 'always';
						const messageResult = !pushBranchSetting ? await vscode.window.showInformationMessage(
							vscode.l10n.t('There is no remote branch on {0}/{1} for \'{2}\'.\n\nDo you want to publish it and then create the pull request?', compareOwner, compareRepositoryName, compareBranchName),
							{ modal: true },
							publish,
							alwaysPublish)
							: publish;
						if (messageResult === alwaysPublish) {
							await vscode.workspace
								.getConfiguration(PR_SETTINGS_NAMESPACE)
								.update(PUSH_BRANCH, 'always', vscode.ConfigurationTarget.Global);
						}
						if ((messageResult === alwaysPublish) || (messageResult === publish)) {
							progress.report({ message: vscode.l10n.t('Pushing branch'), increment: 10 });
							totalIncrement += 10;

							const pushResult = await this.pushUpstream(compareOwner, compareRepositoryName, compareBranchName);
							if (pushResult) {
								existingCompareUpstream = pushResult.compareUpstream;
								headRepo = pushResult.repo;
							} else {
								this._throwError(message, vscode.l10n.t('The current repository does not have a push remote for {0}', compareGithubRemoteName));
							}
						}
					}
					if (!existingCompareUpstream) {
						this._throwError(message, vscode.l10n.t('No remote branch on {0}/{1} for the merge branch.', compareOwner, compareRepositoryName));
						progress.report({ message: vscode.l10n.t('Pull request cancelled'), increment: 100 - totalIncrement });
						return;
					}

					if (!headRepo) {
						throw new Error(vscode.l10n.t('Unable to find GitHub repository matching \'{0}\'. You can add \'{0}\' to the setting "githubPullRequests.remotes" to ensure \'{0}\' is found.', existingCompareUpstream.remoteName));
					}

					progress.report({ message: vscode.l10n.t('Creating pull request'), increment: 70 - totalIncrement });
					totalIncrement += 70 - totalIncrement;
					const head = `${headRepo.remote.owner}:${compareBranchName}`;
					createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head });

					// Create was cancelled
					if (!createdPR) {
						this._throwError(message, vscode.l10n.t('There must be a difference in commits to create a pull request.'));
					} else {
						await postCreate(createdPR);
					}
				} catch (e) {
					if (!createdPR) {
						let errorMessage: string = e.message;
						if (errorMessage.startsWith('GraphQL error: ')) {
							errorMessage = errorMessage.substring('GraphQL error: '.length);
						}
						this._throwError(message, errorMessage);
					} else {
						if (e.message === 'GraphQL error: ["Pull request Pull request is in unstable status"]') {
							// This error can happen if the PR isn't fully created by the time we try to set properties on it. Try again.
							await postCreate(createdPR);
						}
						// All of these errors occur after the PR is created, so the error is not critical.
						vscode.window.showErrorMessage(vscode.l10n.t('There was an error creating the pull request: {0}', e.message));
					}
				} finally {
					let completeMessage: string;
					if (createdPR) {
						await this._replyMessage(message, {});
						this._onDone.fire(createdPR);
						completeMessage = vscode.l10n.t('Pull request created');
					} else {
						completeMessage = vscode.l10n.t('Unable to create pull request');
					}
					progress.report({ message: completeMessage, increment: 100 - totalIncrement });
				}
			});
		});
	}

	private async changeBranch(newBranch: string, isBase: boolean): Promise<{ title: string, description: string }> {
		let compareBranch: Branch | undefined;
		if (isBase) {
			this._baseBranch = newBranch;
			this._onDidChangeBaseBranch.fire(newBranch);
		} else {
			try {
				compareBranch = await this._folderRepositoryManager.repository.getBranch(newBranch);
				this._compareBranch = newBranch;
				this._onDidChangeCompareBranch.fire(compareBranch.name!);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Branch does not exist locally.'));
			}
		}

		compareBranch = compareBranch ?? await this._folderRepositoryManager.repository.getBranch(this._compareBranch);
		return this.getTitleAndDescription(compareBranch, this._baseBranch);
	}

	private async cancel(message: IRequestMessage<CreatePullRequestNew>) {
		vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);
		this._onDone.fire(undefined);
		// Re-fetch the automerge info so that it's updated for next time.
		await this.getMergeConfiguration(message.args.owner, message.args.repo, true);
		return this._replyMessage(message, undefined);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'pr.requestInitialize':
				return this.doInitializeParams();

			case 'pr.cancelCreate':
				return this.cancel(message);

			case 'pr.create':
				return this.create(message);

			case 'pr.changeBaseRemoteAndBranch':
				return this.changeRemoteAndBranch(message, true);

			case 'pr.changeCompareRemoteAndBranch':
				return this.changeRemoteAndBranch(message, false);

			case 'pr.changeLabels':
				return this.addLabels();

			case 'pr.changeReviewers':
				return this.addReviewers();

			case 'pr.changeAssignees':
				return this.addAssignees();

			case 'pr.changeMilestone':
				return this.addMilestone();

			case 'pr.removeLabel':
				return this.removeLabel(message);

			case 'pr.generateTitleAndDescription':
				return this.generateTitleAndDescription(message);

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}

	dispose() {
		super.dispose();
		this._postMessage({ command: 'reset' });
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-create-pr-view-new.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<title>Create Pull Request</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}
