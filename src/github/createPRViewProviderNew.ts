/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChooseBaseRemoteAndBranchResult, ChooseCompareRemoteAndBranchResult, ChooseRemoteAndBranchArgs, CreateParams, CreatePullRequest, RemoteInfo } from '../../common/views';
import type { Branch, Ref } from '../api/api';
import { GitHubServerType } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { GitHubRemote } from '../common/remote';
import {
	ASSIGN_TO,
	CREATE_DRAFT,
	PR_SETTINGS_NAMESPACE,
	PULL_REQUEST_DESCRIPTION,
	PUSH_BRANCH,
	SET_AUTO_MERGE,
} from '../common/settingKeys';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import {
	byRemoteName,
	DetachedHeadError,
	FolderRepositoryManager,
	PullRequestDefaults,
	titleAndBodyFrom,
} from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { ILabel, MergeMethod, RepoAccessAndMergeMethods } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { ISSUE_EXPRESSION, parseIssueExpressionOutput, variableSubstitution } from './utils';

const ISSUE_CLOSING_KEYWORDS = new RegExp('closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve\s$', 'i'); // https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword

export class CreatePullRequestViewProviderNew extends WebviewViewBase implements vscode.WebviewViewProvider {
	private static readonly ID = 'CreatePullRequestViewProvider';
	public readonly viewType = 'github:createPullRequest';

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
			// TODO @RMacfarlane Clear stored state on extension deactivation instead.
			this.initializeParams(true);
		} else {
			this.initializeParams();
		}
	}

	private _defaultCompareBranch: Branch;
	get defaultCompareBranch() {
		return this._defaultCompareBranch;
	}

	set defaultCompareBranch(compareBranch: Branch | undefined) {
		const branchChanged = compareBranch && (compareBranch.name !== this._defaultCompareBranch.name ||
			compareBranch.upstream?.remote !== this._defaultCompareBranch.upstream?.remote);
		const commitChanged = compareBranch && (compareBranch.commit !== this._defaultCompareBranch.commit);
		if (branchChanged || commitChanged) {
			this._defaultCompareBranch = compareBranch!;
			this.changeBranch(compareBranch!.name!, false).then(titleAndDescription => {
				const params: Partial<CreateParams> = {
					defaultTitle: titleAndDescription.title,
					defaultDescription: titleAndDescription.description,
					compareBranch: compareBranch?.name,
					defaultCompareBranch: compareBranch?.name
				};
				return this._postMessage({
					command: 'reset',
					params,
				});
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
		// Do the fast initialization first, then update with the slower initialization.
		const params = await this.initializeParamsFast(reset);
		this.initializeParamsSlow(params);
	}

	private async initializeParamsSlow(params: CreateParams): Promise<void> {
		if (!this.defaultCompareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}
		if (!params.defaultBaseRemote || !params.defaultCompareRemote) {
			throw new Error('Create Pull Request view unable to initialize without default remotes.');
		}
		const defaultOrigin = await this._folderRepositoryManager.getOrigin(this.defaultCompareBranch);
		const viewerPermission = await defaultOrigin.getViewerPermission();
		commands.setContext(contexts.CREATE_PR_PERMISSIONS, viewerPermission);

		const branchesForRemote = await defaultOrigin.listBranches(this._pullRequestDefaults.owner, this._pullRequestDefaults.repo);
		// Ensure default into branch is in the remotes list
		if (!branchesForRemote.includes(this._pullRequestDefaults.base)) {
			branchesForRemote.push(this._pullRequestDefaults.base);
			branchesForRemote.sort();
		}

		let branchesForCompare = branchesForRemote;
		if (params.defaultCompareRemote.owner !== params.defaultBaseRemote.owner) {
			branchesForCompare = await defaultOrigin.listBranches(
				params.defaultCompareRemote.owner,
				params.defaultCompareRemote.repositoryName,
			);
		}

		// Ensure default from branch is in the remotes list
		if (this.defaultCompareBranch.name && !branchesForCompare.includes(this.defaultCompareBranch.name)) {
			branchesForCompare.push(this.defaultCompareBranch.name);
			branchesForCompare.sort();
		}
		params.branchesForRemote = branchesForRemote;
		params.branchesForCompare = branchesForCompare;
		this._postMessage({
			command: 'pr.initialize',
			params,
		});
	}

	private async initializeParamsFast(reset: boolean = false): Promise<CreateParams> {
		if (!this.defaultCompareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultBaseRemote: RemoteInfo = {
			owner: this._pullRequestDefaults.owner,
			repositoryName: this._pullRequestDefaults.repo,
		};

		const defaultOrigin = await this._folderRepositoryManager.getOrigin(this.defaultCompareBranch);
		const defaultCompareRemote: RemoteInfo = {
			owner: defaultOrigin.remote.owner,
			repositoryName: defaultOrigin.remote.repositoryName,
		};

		const defaultBaseBranch = this._pullRequestDefaults.base;
		const [configuredGitHubRemotes, allGitHubRemotes, defaultTitleAndDescription, mergeConfiguration] = await Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.getAllGitHubRemotes(),
			this.getTitleAndDescription(this.defaultCompareBranch, defaultBaseBranch),
			this.getMergeConfiguration(defaultBaseRemote.owner, defaultBaseRemote.repositoryName)
		]);

		const configuredRemotes: RemoteInfo[] = configuredGitHubRemotes.map(remote => {
			return {
				owner: remote.owner,
				repositoryName: remote.repositoryName,
			};
		});

		const allRemotes: RemoteInfo[] = allGitHubRemotes.map(remote => {
			return {
				owner: remote.owner,
				repositoryName: remote.repositoryName,
			};
		});
		const defaultCompareBranch = this.defaultCompareBranch.name ?? '';

		const params: CreateParams = {
			availableBaseRemotes: configuredRemotes,
			availableCompareRemotes: allRemotes,
			defaultBaseRemote,
			defaultBaseBranch,
			defaultCompareRemote,
			defaultCompareBranch,
			branchesForRemote: [defaultBaseBranch], // We'll populate the branches in the slow phase as they are less likely to be needed.
			branchesForCompare: [defaultCompareBranch],
			defaultTitle: defaultTitleAndDescription.title,
			defaultDescription: defaultTitleAndDescription.description,
			defaultMergeMethod: getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability),
			allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
			mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
			autoMergeDefault: mergeConfiguration.viewerCanAutoMerge && (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(SET_AUTO_MERGE, false) === true),
			createError: '',
			labels: this.labels,
			isDraftDefault: vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get(CREATE_DRAFT, false),
			isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
		};

		Logger.appendLine(`Initializing "create" view: ${JSON.stringify(params)}`, CreatePullRequestViewProviderNew.ID);

		this._compareBranch = this.defaultCompareBranch.name ?? '';
		this._baseBranch = defaultBaseBranch;
		this._baseRemote = defaultBaseRemote;

		this._postMessage({
			command: reset ? 'reset' : 'pr.initialize',
			params,
		});
		return params;
	}


	private async remotePicks(isBase: boolean): Promise<(vscode.QuickPickItem & { remote?: RemoteInfo })[]> {
		const remotes = isBase ? await this._folderRepositoryManager.getGitHubRemotes() : this._folderRepositoryManager.gitHubRepositories.map(repo => repo.remote);
		return remotes.map(remote => {
			return {
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
			label: vscode.l10n.t('Branches')
		});
		branchPicks.unshift({
			iconPath: new vscode.ThemeIcon('github-alt'),
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
			chooseResult = {
				baseRemote: result.remote,
				baseBranch: result.branch,
				defaultBaseBranch: defaultBranch,
				defaultMergeMethod: getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability),
				allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
				mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
				autoMergeDefault: mergeConfiguration.viewerCanAutoMerge && (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(SET_AUTO_MERGE, false) === true),
				defaultTitle: titleAndDescription.title,
				defaultDescription: titleAndDescription.description
			};
			if (baseRemoteChanged) {
				this._onDidChangeBaseRemote.fire(this._baseRemote);
			}
			if (baseBranchChanged) {
				this._onDidChangeBaseBranch.fire(this._baseBranch);
			}
		} else {
			this._compareBranch = result.branch;
			chooseResult = {
				compareRemote: result.remote,
				compareBranch: result.branch,
				defaultCompareBranch: defaultBranch
			};
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

		const chooseDifferentRemote = vscode.l10n.t('Choose a different repository...');
		const remotePlaceholder = vscode.l10n.t('Choose a remote');
		quickPick.placeholder = githubRepository ? vscode.l10n.t('Choose a branch from {0}', `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`) : remotePlaceholder;
		quickPick.show();
		quickPick.busy = true;
		quickPick.items = githubRepository ? await this.branchPicks(githubRepository, chooseDifferentRemote, isBase) : await this.remotePicks(isBase);
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
				} else if ((selectedPick.branch === undefined) && selectedPick.remote) {
					const selectedRemote = selectedPick as vscode.QuickPickItem & { remote: RemoteInfo };
					quickPick.busy = true;
					githubRepository = this._folderRepositoryManager.findRepo(repo => repo.remote.owner === selectedRemote.remote.owner && repo.remote.repositoryName === selectedRemote.remote.repositoryName)!;
					quickPick.items = await this.branchPicks(githubRepository, chooseDifferentRemote, isBase);
					quickPick.placeholder = vscode.l10n.t('Choose a branch from {0}', `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`);
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

	private labels: ILabel[] = [];
	public async addLabels(): Promise<void> {
		let newLabels: ILabel[] = [];

		async function getLabelOptions(
			folderRepoManager: FolderRepositoryManager,
			labels: ILabel[],
			base: RemoteInfo
		): Promise<vscode.QuickPickItem[]> {
			newLabels = await folderRepoManager.getLabels(undefined, { owner: base.owner, repo: base.repositoryName });

			return newLabels.map(label => {
				return {
					label: label.name,
					picked: labels.some(existingLabel => existingLabel.name === label.name)
				};
			});
		}

		const labelsToAdd = await vscode.window.showQuickPick(
			getLabelOptions(this._folderRepositoryManager, this.labels, this._baseRemote),
			{ canPickMany: true },
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
			return { compareUpstream: createdPushRemote, repo: this._folderRepositoryManager.findRepo(byRemoteName(createdPushRemote.remoteName)) };
		}
	}

	private async create(message: IRequestMessage<CreatePullRequest>): Promise<void> {
		Logger.debug(`Creating pull request with args ${JSON.stringify(message.args)}`, CreatePullRequestViewProviderNew.ID);
		vscode.window.withProgress({ location: { viewId: 'github:createPullRequest' } }, () => {
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
							vscode.l10n.t('There is no upstream branch for \'{0}\'.\n\nDo you want to publish it and then create the pull request?', compareBranchName),
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
						this._throwError(message, vscode.l10n.t('No upstream for the compare branch.'));
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
						await Promise.all([
							this.setLabels(createdPR, message.args.labels),
							this.enableAutoMerge(createdPR, message.args.autoMerge, message.args.autoMergeMethod),
							this.autoAssign(createdPR)]);
					}
				} catch (e) {
					if (!createdPR) {
						this._throwError(message, e.message);
					} else {
						// All of these errors occur after the PR is created, so the error is not critical.
						vscode.window.showErrorMessage(vscode.l10n.t('There was an error creating the pull request: {0}', e.message));
					}
				} finally {
					if (createdPR) {
						await this._replyMessage(message, {});
						this._onDone.fire(createdPR);
					}
					progress.report({ message: vscode.l10n.t('Pull request created'), increment: 100 - totalIncrement });
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

	private async cancel(message: IRequestMessage<CreatePullRequest>) {
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
			case 'pr.cancelCreate':
				return this.cancel(message);

			case 'pr.create':
				return this.create(message);

			case 'pr.changeBaseRemoteAndBranch':
				return this.changeRemoteAndBranch(message, true);

			case 'pr.changeCompareRemoteAndBranch':
				return this.changeRemoteAndBranch(message, false);

			case 'pr.removeLabel':
				return this.removeLabel(message);

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
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
