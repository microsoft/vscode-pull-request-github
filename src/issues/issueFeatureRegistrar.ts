/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { ITelemetry } from '../common/telemetry';
import { OctokitCommon } from '../github/common';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IssueModel } from '../github/issueModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getRepositoryForFile, ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput } from '../github/utils';
import { ReviewManager } from '../view/reviewManager';
import { CurrentIssue } from './currentIssue';
import { IssueCompletionProvider } from './issueCompletionProvider';
import {
	ASSIGNEES,
	extractIssueOriginFromQuery,
	IssueFileSystemProvider,
	LabelCompletionProvider,
	LABELS,
	NEW_ISSUE_FILE,
	NEW_ISSUE_SCHEME,
	NewIssueCache,
} from './issueFile';
import { IssueHoverProvider } from './issueHoverProvider';
import { openCodeLink } from './issueLinkLookup';
import { IssuesTreeData, IssueUriTreeItem } from './issuesView';
import { IssueTodoProvider } from './issueTodoProvider';
import { StateManager } from './stateManager';
import { UserCompletionProvider } from './userCompletionProvider';
import { UserHoverProvider } from './userHoverProvider';
import {
	createGitHubLink,
	createGithubPermalink,
	getIssue,
	ISSUES_CONFIGURATION,
	NewIssue,
	PermalinkInfo,
	pushAndCreatePR,
	QUERIES_CONFIGURATION,
	USER_EXPRESSION,
} from './util';

const ISSUE_COMPLETIONS_CONFIGURATION = 'issueCompletions.enabled';
const USER_COMPLETIONS_CONFIGURATION = 'userCompletions.enabled';

const CREATING_ISSUE_FROM_FILE_CONTEXT = 'issues.creatingFromFile';

export class IssueFeatureRegistrar implements vscode.Disposable {
	private _stateManager: StateManager;
	private _newIssueCache: NewIssueCache;

	private createIssueInfo:
		| {
			document: vscode.TextDocument;
			newIssue: NewIssue | undefined;
			lineNumber: number | undefined;
			insertIndex: number | undefined;
		}
		| undefined;

	constructor(
		private gitAPI: GitApiImpl,
		private manager: RepositoriesManager,
		private reviewManagers: ReviewManager[],
		private context: vscode.ExtensionContext,
		private telemetry: ITelemetry,
	) {
		this._stateManager = new StateManager(gitAPI, this.manager, this.context);
		this._newIssueCache = new NewIssueCache(context);
	}

	async initialize() {
		this.context.subscriptions.push(
			vscode.workspace.registerFileSystemProvider(NEW_ISSUE_SCHEME, new IssueFileSystemProvider(this._newIssueCache)),
		);
		this.context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(
				{ scheme: NEW_ISSUE_SCHEME },
				new LabelCompletionProvider(this.manager),
				' ',
				',',
			),
		);
		this.context.subscriptions.push(
			vscode.window.createTreeView('issues:github', {
				showCollapseAll: true,
				treeDataProvider: new IssuesTreeData(this._stateManager, this.manager, this.context),
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.createIssueFromSelection',
				(newIssue?: NewIssue, issueBody?: string) => {
					/* __GDPR__
				"issue.createIssueFromSelection" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.createIssueFromSelection');
					return this.createTodoIssue(newIssue, issueBody);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.createIssueFromClipboard',
				() => {
					/* __GDPR__
				"issue.createIssueFromClipboard" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.createIssueFromClipboard');
					return this.createTodoIssueClipboard();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.copyGithubPermalink',
				(fileUri: any) => {
					/* __GDPR__
				"issue.copyGithubPermalink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubPermalink');
					return this.copyPermalink(this.manager, fileUri instanceof vscode.Uri ? fileUri : undefined);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.copyGithubHeadLink',
				(fileUri: any) => {
					/* __GDPR__
				"issue.copyGithubHeadLink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubHeadLink');
					return this.copyHeadLink(fileUri);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.copyMarkdownGithubPermalink',
				() => {
					/* __GDPR__
				"issue.copyMarkdownGithubPermalink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyMarkdownGithubPermalink');
					return this.copyMarkdownPermalink(this.manager);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.openGithubPermalink',
				() => {
					/* __GDPR__
				"issue.openGithubPermalink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.openGithubPermalink');
					return this.openPermalink(this.manager);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.openIssue', (issueModel: any) => {
				/* __GDPR__
				"issue.openIssue" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.openIssue');
				return this.openIssue(issueModel);
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.startWorking',
				(issue: any) => {
					/* __GDPR__
				"issue.startWorking" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.startWorking');
					return this.startWorking(issue);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.startWorkingBranchDescriptiveTitle',
				(issue: any) => {
					/* __GDPR__
				"issue.startWorking" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.startWorking');
					return this.startWorking(issue);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.continueWorking',
				(issue: any) => {
					/* __GDPR__
				"issue.continueWorking" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.continueWorking');
					return this.startWorking(issue);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.startWorkingBranchPrompt',
				(issueModel: any) => {
					/* __GDPR__
				"issue.startWorkingBranchPrompt" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.startWorkingBranchPrompt');
					return this.startWorkingBranchPrompt(issueModel);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.stopWorking',
				(issueModel: any) => {
					/* __GDPR__
				"issue.stopWorking" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.stopWorking');
					return this.stopWorking(issueModel);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.stopWorkingBranchDescriptiveTitle',
				(issueModel: any) => {
					/* __GDPR__
				"issue.stopWorking" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.stopWorking');
					return this.stopWorking(issueModel);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.statusBar',
				() => {
					/* __GDPR__
				"issue.statusBar" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.statusBar');
					return this.statusBar();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.copyIssueNumber', (issueModel: any) => {
				/* __GDPR__
				"issue.copyIssueNumber" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.copyIssueNumber');
				return this.copyIssueNumber(issueModel);
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.copyIssueUrl', (issueModel: any) => {
				/* __GDPR__
				"issue.copyIssueUrl" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.copyIssueUrl');
				return this.copyIssueUrl(issueModel);
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.refresh',
				() => {
					/* __GDPR__
				"issue.refresh" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.refresh');
					return this.refreshView();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.suggestRefresh',
				() => {
					/* __GDPR__
				"issue.suggestRefresh" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.suggestRefresh');
					return this.suggestRefresh();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.getCurrent',
				() => {
					/* __GDPR__
				"issue.getCurrent" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.getCurrent');
					return this.getCurrent();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.editQuery',
				(query: IssueUriTreeItem) => {
					/* __GDPR__
				"issue.editQuery" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.editQuery');
					return this.editQuery(query);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.createIssue',
				() => {
					/* __GDPR__
				"issue.createIssue" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.createIssue');
					return this.createIssue();
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand(
				'issue.createIssueFromFile',
				async () => {
					/* __GDPR__
				"issue.createIssueFromFile" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.createIssueFromFile');
					await vscode.commands.executeCommand('setContext', CREATING_ISSUE_FROM_FILE_CONTEXT, true);
					await this.createIssueFromFile();
					await vscode.commands.executeCommand('setContext', CREATING_ISSUE_FROM_FILE_CONTEXT, false);
				},
				this,
			),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.issueCompletion', () => {
				/* __GDPR__
				"issue.issueCompletion" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.issueCompletion');
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.userCompletion', () => {
				/* __GDPR__
				"issue.userCompletion" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.userCompletion');
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.signinAndRefreshList', async () => {
				return this.manager.authenticate();
			}),
		);
		this.context.subscriptions.push(
			vscode.commands.registerCommand('issue.goToLinkedCode', async (issueModel: any) => {
				return openCodeLink(issueModel, this.manager);
			}),
		);
		this._stateManager.tryInitializeAndWait().then(() => {
			this.registerCompletionProviders();

			this.context.subscriptions.push(
				vscode.languages.registerHoverProvider(
					'*',
					new IssueHoverProvider(this.manager, this._stateManager, this.context, this.telemetry),
				),
			);
			this.context.subscriptions.push(
				vscode.languages.registerHoverProvider('*', new UserHoverProvider(this.manager, this.telemetry)),
			);
			this.context.subscriptions.push(
				vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider(this.context), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
			);
		});
	}

	dispose() { }

	private documentFilters: Array<vscode.DocumentFilter | string> = [
		{ language: 'php' },
		{ language: 'powershell' },
		{ language: 'jade' },
		{ language: 'python' },
		{ language: 'r' },
		{ language: 'razor' },
		{ language: 'ruby' },
		{ language: 'rust' },
		{ language: 'scss' },
		{ language: 'search-result' },
		{ language: 'shaderlab' },
		{ language: 'shellscript' },
		{ language: 'sql' },
		{ language: 'swift' },
		{ language: 'typescript' },
		{ language: 'vb' },
		{ language: 'xml' },
		{ language: 'yaml' },
		{ language: 'markdown' },
		{ language: 'bat' },
		{ language: 'clojure' },
		{ language: 'coffeescript' },
		{ language: 'jsonc' },
		{ language: 'c' },
		{ language: 'cpp' },
		{ language: 'csharp' },
		{ language: 'css' },
		{ language: 'dockerfile' },
		{ language: 'fsharp' },
		{ language: 'git-commit' },
		{ language: 'go' },
		{ language: 'groovy' },
		{ language: 'handlebars' },
		{ language: 'hlsl' },
		{ language: 'html' },
		{ language: 'ini' },
		{ language: 'java' },
		{ language: 'javascriptreact' },
		{ language: 'javascript' },
		{ language: 'json' },
		{ language: 'less' },
		{ language: 'log' },
		{ language: 'lua' },
		{ language: 'makefile' },
		{ language: 'ignore' },
		{ language: 'properties' },
		{ language: 'objective-c' },
		{ language: 'perl' },
		{ language: 'perl6' },
		{ language: 'typescriptreact' },
		{ language: 'yml' },
		'*',
	];
	private registerCompletionProviders() {
		const providers: {
			provider: typeof IssueCompletionProvider | typeof UserCompletionProvider;
			trigger: string;
			disposable: vscode.Disposable | undefined;
			configuration: string;
		}[] = [
				{
					provider: IssueCompletionProvider,
					trigger: '#',
					disposable: undefined,
					configuration: ISSUE_COMPLETIONS_CONFIGURATION,
				},
				{
					provider: UserCompletionProvider,
					trigger: '@',
					disposable: undefined,
					configuration: USER_COMPLETIONS_CONFIGURATION,
				},
			];
		for (const element of providers) {
			if (vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(element.configuration, true)) {
				this.context.subscriptions.push(
					(element.disposable = vscode.languages.registerCompletionItemProvider(
						this.documentFilters,
						new element.provider(this._stateManager, this.manager, this.context),
						element.trigger,
					)),
				);
			}
		}
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(change => {
				for (const element of providers) {
					if (change.affectsConfiguration(`${ISSUES_CONFIGURATION}.${element.configuration}`)) {
						const newValue: boolean = vscode.workspace
							.getConfiguration(ISSUES_CONFIGURATION)
							.get(element.configuration, true);
						if (!newValue && element.disposable) {
							element.disposable.dispose();
							element.disposable = undefined;
						} else if (newValue && !element.disposable) {
							this.context.subscriptions.push(
								(element.disposable = vscode.languages.registerCompletionItemProvider(
									this.documentFilters,
									new element.provider(this._stateManager, this.manager, this.context),
									element.trigger,
								)),
							);
						}
						break;
					}
				}
			}),
		);
	}

	async createIssue() {
		let uri = vscode.window.activeTextEditor?.document.uri;
		if (!uri) {
			uri = (await this.chooseRepo('Select the repo to create the issue in.'))?.repository.rootUri;
		}
		if (uri) {
			return this.makeNewIssueFile(uri);
		}
	}

	async createIssueFromFile() {
		let text: string;
		if (
			!vscode.window.activeTextEditor ||
			vscode.window.activeTextEditor.document.uri.scheme !== NEW_ISSUE_SCHEME
		) {
			return;
		}
		text = vscode.window.activeTextEditor.document.getText();
		const indexOfEmptyLineWindows = text.indexOf('\r\n\r\n');
		const indexOfEmptyLineOther = text.indexOf('\n\n');
		let indexOfEmptyLine: number;
		if (indexOfEmptyLineWindows < 0 && indexOfEmptyLineOther < 0) {
			return;
		} else {
			if (indexOfEmptyLineWindows < 0) {
				indexOfEmptyLine = indexOfEmptyLineOther;
			} else if (indexOfEmptyLineOther < 0) {
				indexOfEmptyLine = indexOfEmptyLineWindows;
			} else {
				indexOfEmptyLine = Math.min(indexOfEmptyLineWindows, indexOfEmptyLineOther);
			}
		}
		const title = text.substring(0, indexOfEmptyLine);
		let assignees: string[] | undefined;
		text = text.substring(indexOfEmptyLine + 2).trim();
		if (text.startsWith(ASSIGNEES)) {
			const lines = text.split(/\r\n|\n/, 1);
			if (lines.length === 1) {
				assignees = lines[0]
					.substring(ASSIGNEES.length)
					.split(',')
					.map(value => {
						value = value.trim();
						if (value.startsWith('@')) {
							value = value.substring(1);
						}
						return value;
					});
				text = text.substring(lines[0].length).trim();
			}
		}
		let labels: string[] | undefined;
		if (text.startsWith(LABELS)) {
			const lines = text.split(/\r\n|\n/, 1);
			if (lines.length === 1) {
				labels = lines[0]
					.substring(LABELS.length)
					.split(',')
					.map(value => value.trim())
					.filter(label => label);
				text = text.substring(lines[0].length).trim();
			}
		}
		const body = text;
		if (!title || !body) {
			return;
		}
		const createSucceeded = await this.doCreateIssue(
			this.createIssueInfo?.document,
			this.createIssueInfo?.newIssue,
			title,
			body,
			assignees,
			labels,
			this.createIssueInfo?.lineNumber,
			this.createIssueInfo?.insertIndex,
			extractIssueOriginFromQuery(vscode.window.activeTextEditor.document.uri),
		);
		this.createIssueInfo = undefined;
		if (createSucceeded) {
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			this._newIssueCache.clear();
		}
	}

	async editQuery(query: IssueUriTreeItem) {
		const config = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION);
		const inspect = config.inspect<{ label: string; query: string }[]>(QUERIES_CONFIGURATION);
		let command: string;
		if (inspect?.workspaceValue) {
			command = 'workbench.action.openWorkspaceSettingsFile';
		} else {
			const value = config.get<{ label: string; query: string }[]>(QUERIES_CONFIGURATION);
			if (inspect?.defaultValue && JSON.stringify(inspect?.defaultValue) === JSON.stringify(value)) {
				config.update(QUERIES_CONFIGURATION, inspect.defaultValue, vscode.ConfigurationTarget.Global);
			}
			command = 'workbench.action.openSettingsJson';
		}
		await vscode.commands.executeCommand(command);
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const text = editor.document.getText();
			const search = text.search(query.labelAsString!);
			if (search >= 0) {
				const position = editor.document.positionAt(search);
				editor.revealRange(new vscode.Range(position, position));
				editor.selection = new vscode.Selection(position, position);
			}
		}
	}

	getCurrent() {
		// This is used by the "api" command issues.getCurrent
		const currentIssues = this._stateManager.currentIssues();
		if (currentIssues.length > 0) {
			return {
				owner: currentIssues[0].issue.remote.owner,
				repo: currentIssues[0].issue.remote.repositoryName,
				number: currentIssues[0].issue.number,
			};
		}
		return undefined;
	}

	refreshView() {
		this._stateManager.refreshCacheNeeded();
	}

	async suggestRefresh() {
		await vscode.commands.executeCommand('hideSuggestWidget');
		await this._stateManager.refresh();
		return vscode.commands.executeCommand('editor.action.triggerSuggest');
	}

	openIssue(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.openExternal(vscode.Uri.parse(issueModel.html_url));
		}
		return undefined;
	}

	async doStartWorking(
		matchingRepoManager: FolderRepositoryManager | undefined,
		issueModel: IssueModel,
		needsBranchPrompt?: boolean,
	) {
		let repoManager = matchingRepoManager;
		let githubRepository = issueModel.githubRepository;
		let remote = issueModel.remote;
		if (!repoManager) {
			repoManager = await this.chooseRepo('Choose which repository you want to work on this isssue in.');
			if (!repoManager) {
				return;
			}
			githubRepository = await repoManager.getOrigin();
			remote = githubRepository.remote;
		}

		const remoteNameResult = await repoManager.findUpstreamForItem({ githubRepository, remote });
		if (remoteNameResult.needsFork) {
			if ((await repoManager.tryOfferToFork(githubRepository)) === undefined) {
				return;
			}
		}

		await this._stateManager.setCurrentIssue(
			repoManager,
			new CurrentIssue(issueModel, repoManager, this._stateManager, remoteNameResult.remote, needsBranchPrompt),
		);
	}

	async startWorking(issue: any) {
		if (issue instanceof IssueModel) {
			return this.doStartWorking(this.manager.getManagerForIssueModel(issue), issue);
		} else if (issue instanceof vscode.Uri) {
			const match = issue.toString().match(ISSUE_OR_URL_EXPRESSION);
			const parsed = parseIssueExpressionOutput(match);
			const folderManager = this.manager.folderManagers.find(folderManager =>
				folderManager.gitHubRepositories.find(repo => repo.remote.owner === parsed?.owner && repo.remote.repositoryName === parsed.name));
			if (parsed && folderManager) {
				const issueModel = await getIssue(this._stateManager, folderManager, issue.toString(), parsed);
				if (issueModel) {
					return this.doStartWorking(folderManager, issueModel);
				}
			}
		}
	}

	async startWorkingBranchPrompt(issueModel: any) {
		if (!(issueModel instanceof IssueModel)) {
			return;
		}
		this.doStartWorking(this.manager.getManagerForIssueModel(issueModel), issueModel, true);
	}

	async stopWorking(issueModel: any) {
		let folderManager = this.manager.getManagerForIssueModel(issueModel);
		if (!folderManager) {
			folderManager = await this.chooseRepo('Choose which repository you want to stop working on this issue in.');
			if (!folderManager) {
				return;
			}
		}
		if (
			issueModel instanceof IssueModel &&
			this._stateManager.currentIssue(folderManager.repository.rootUri)?.issue.number === issueModel.number
		) {
			await this._stateManager.setCurrentIssue(folderManager, undefined);
		}
	}

	private async statusBarActions(currentIssue: CurrentIssue) {
		const openIssueText: string = `$(globe) Open #${currentIssue.issue.number} ${currentIssue.issue.title}`;
		const pullRequestText: string = `$(git-pull-request) Create pull request for #${currentIssue.issue.number} (pushes branch)`;
		let defaults: PullRequestDefaults | undefined;
		try {
			defaults = await currentIssue.manager.getPullRequestDefaults();
		} catch (e) {
			// leave defaults undefined
		}
		const stopWorkingText: string = `$(primitive-square) Stop working on #${currentIssue.issue.number}`;
		const choices =
			currentIssue.branchName && defaults
				? [openIssueText, pullRequestText, stopWorkingText]
				: [openIssueText, pullRequestText, stopWorkingText];
		const response: string | undefined = await vscode.window.showQuickPick(choices, {
			placeHolder: 'Current issue options',
		});
		switch (response) {
			case openIssueText:
				return this.openIssue(currentIssue.issue);
			case pullRequestText: {
				const reviewManager = ReviewManager.getReviewManagerForFolderManager(
					this.reviewManagers,
					currentIssue.manager,
				);
				if (reviewManager) {
					return pushAndCreatePR(currentIssue.manager, reviewManager, this._stateManager);
				}
				break;
			}
			case stopWorkingText:
				return this._stateManager.setCurrentIssue(currentIssue.manager, undefined);
		}
	}

	async statusBar() {
		const currentIssues = this._stateManager.currentIssues();
		if (currentIssues.length === 1) {
			return this.statusBarActions(currentIssues[0]);
		} else {
			interface IssueChoice extends vscode.QuickPickItem {
				currentIssue: CurrentIssue;
			}
			const choices: IssueChoice[] = currentIssues.map(currentIssue => {
				return {
					label: `#${currentIssue.issue.number} from ${currentIssue.issue.githubRepository.remote.owner}/${currentIssue.issue.githubRepository.remote.repositoryName}`,
					currentIssue,
				};
			});
			const response: IssueChoice | undefined = await vscode.window.showQuickPick(choices);
			if (response) {
				return this.statusBarActions(response.currentIssue);
			}
		}
	}

	private stringToUint8Array(input: string): Uint8Array {
		const encoder = new TextEncoder();
		return encoder.encode(input);
	}

	copyIssueNumber(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.number.toString());
		}
		return undefined;
	}

	copyIssueUrl(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.html_url);
		}
		return undefined;
	}

	async createTodoIssueClipboard() {
		return this.createTodoIssue(undefined, await vscode.env.clipboard.readText());
	}

	private async createTodoIssueBody(newIssue?: NewIssue, issueBody?: string): Promise<string | undefined> {
		if (issueBody || newIssue?.document.isUntitled) {
			return issueBody;
		}

		let contents = '';
		if (newIssue) {
			const repository = getRepositoryForFile(this.gitAPI, newIssue.document.uri);
			const changeAffectingFile = repository?.state.workingTreeChanges.find(value => value.uri.toString() === newIssue.document.uri.toString());
			if (changeAffectingFile) {
				// The file we're creating the issue for has uncommitted changes.
				// Add a quote of the line so that the issue body is still meaningful.
				contents = `\`\`\`\n${newIssue.line}\n\`\`\`\n\n`;
			}
		}
		contents += (await createGithubPermalink(this.manager, this.gitAPI, newIssue)).permalink;
		return contents;
	}

	async createTodoIssue(newIssue?: NewIssue, issueBody?: string) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		let assignee: string[] | undefined;
		let issueGenerationText: string | undefined;
		if (!newIssue && vscode.window.activeTextEditor) {
			document = vscode.window.activeTextEditor.document;
			issueGenerationText = document.getText(vscode.window.activeTextEditor.selection);
		} else if (newIssue) {
			document = newIssue.document;
			insertIndex = newIssue.insertIndex;
			lineNumber = newIssue.lineNumber;
			titlePlaceholder = newIssue.line.substring(insertIndex, newIssue.line.length).trim();
			issueGenerationText = document.getText(
				newIssue.range.isEmpty ? document.lineAt(newIssue.range.start.line).range : newIssue.range,
			);
		} else {
			return undefined;
		}
		const matches = issueGenerationText.match(USER_EXPRESSION);
		if (matches && matches.length === 2 && (await this._stateManager.getUserMap(document.uri)).has(matches[1])) {
			assignee = [matches[1]];
		}
		let title: string | undefined;
		const body: string | undefined = await this.createTodoIssueBody(newIssue, issueBody);

		const quickInput = vscode.window.createInputBox();
		quickInput.value = titlePlaceholder ?? '';
		quickInput.prompt =
			'Set the issue title. Confirm to create the issue now or use the edit button to edit the issue title and description.';
		quickInput.title = 'Create Issue';
		quickInput.buttons = [
			{
				iconPath: new vscode.ThemeIcon('edit'),
				tooltip: 'Edit Description',
			},
		];
		quickInput.onDidAccept(async () => {
			title = quickInput.value;
			if (title) {
				quickInput.busy = true;
				await this.doCreateIssue(document, newIssue, title, body, assignee, undefined, lineNumber, insertIndex);
				quickInput.busy = false;
			}
			quickInput.hide();
		});
		quickInput.onDidTriggerButton(async () => {
			title = quickInput.value;
			quickInput.busy = true;
			this.createIssueInfo = { document, newIssue, lineNumber, insertIndex };

			this.makeNewIssueFile(document.uri, title, body, assignee);
			quickInput.busy = false;
			quickInput.hide();
		});
		quickInput.show();

		return undefined;
	}

	private async makeNewIssueFile(
		originUri: vscode.Uri,
		title?: string,
		body?: string,
		assignees?: string[] | undefined,
	) {
		const query = `?{"origin":"${originUri.toString()}"}`;
		const bodyPath = vscode.Uri.parse(`${NEW_ISSUE_SCHEME}:/${NEW_ISSUE_FILE}${query}`);
		if (
			vscode.window.visibleTextEditors.filter(
				visibleEditor => visibleEditor.document.uri.scheme === NEW_ISSUE_SCHEME,
			).length > 0
		) {
			return;
		}
		await vscode.workspace.fs.delete(bodyPath);
		const assigneeLine = `${ASSIGNEES} ${assignees && assignees.length > 0 ? assignees.map(value => '@' + value).join(', ') + ' ' : ''
			}`;
		const labelLine = `${LABELS} `;
		const text = this._newIssueCache.get() ?? `${title ?? 'Issue Title'}\n
${assigneeLine}
${labelLine}\n
${body ?? ''}\n
<!-- Edit the body of your new issue then click the ✓ \"Create Issue\" button in the top right of the editor. The first line will be the issue title. Assignees and Labels follow after a blank line. Leave an empty line before beginning the body of the issue. -->`;
		await vscode.workspace.fs.writeFile(bodyPath, this.stringToUint8Array(text));
		const assigneesDecoration = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: ' Comma-separated usernames, either @username or just username.',
				fontStyle: 'italic',
				color: new vscode.ThemeColor('issues.newIssueDecoration'),
			},
		});
		const labelsDecoration = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: ' Comma-separated labels.',
				fontStyle: 'italic',
				color: new vscode.ThemeColor('issues.newIssueDecoration'),
			},
		});
		const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(textEditor => {
			if (textEditor?.document.uri.scheme === NEW_ISSUE_SCHEME) {
				const assigneeFullLine = textEditor.document.lineAt(2);
				if (assigneeFullLine.text.startsWith(ASSIGNEES)) {
					textEditor.setDecorations(assigneesDecoration, [
						new vscode.Range(
							new vscode.Position(2, 0),
							new vscode.Position(2, assigneeFullLine.text.length),
						),
					]);
				}
				const labelFullLine = textEditor.document.lineAt(3);
				if (labelFullLine.text.startsWith(LABELS)) {
					textEditor.setDecorations(labelsDecoration, [
						new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, labelFullLine.text.length)),
					]);
				}
			}
		});

		const editor = await vscode.window.showTextDocument(bodyPath);
		const closeDisposable = vscode.workspace.onDidCloseTextDocument(textDocument => {
			if (textDocument === editor.document) {
				editorChangeDisposable.dispose();
				closeDisposable.dispose();
			}
		});
	}

	private async verifyLabels(
		folderManager: FolderRepositoryManager,
		createParams: OctokitCommon.IssuesCreateParams,
	): Promise<boolean> {
		if (!createParams.labels) {
			return true;
		}
		const allLabels = (await folderManager.getLabels(undefined, createParams)).map(label => label.name);
		const newLabels: string[] = [];
		const filteredLabels: string[] = [];
		createParams.labels?.forEach(paramLabel => {
			let label = typeof paramLabel === 'string' ? paramLabel : paramLabel.name;
			if (!label) {
				return;
			}

			if (allLabels.includes(label)) {
				filteredLabels.push(label);
			} else {
				newLabels.push(label);
			}
		});

		if (newLabels.length > 0) {
			const yes = 'Yes';
			const no = 'No';
			const promptResult = await vscode.window.showInformationMessage(
				`The following labels don't exist in this repository: ${newLabels.join(
					', ',
				)}. \nDo you want to create these labels?`,
				{ modal: true },
				yes,
				no,
			);
			switch (promptResult) {
				case yes:
					return true;
				case no: {
					createParams.labels = filteredLabels;
					return true;
				}
				default:
					return false;
			}
		}
		return true;
	}

	private async chooseRepo(prompt: string): Promise<FolderRepositoryManager | undefined> {
		interface RepoChoice extends vscode.QuickPickItem {
			repo: FolderRepositoryManager;
		}
		const choices: RepoChoice[] = [];
		for (const folderManager of this.manager.folderManagers) {
			try {
				const defaults = await folderManager.getPullRequestDefaults();
				choices.push({
					label: `${defaults.owner}/${defaults.repo}`,
					repo: folderManager,
				});
			} catch (e) {
				// ignore
			}
		}
		if (choices.length === 0) {
			return;
		} else if (choices.length === 1) {
			return choices[0].repo;
		}

		const choice = await vscode.window.showQuickPick(choices, { placeHolder: prompt });
		return choice?.repo;
	}

	private async doCreateIssue(
		document: vscode.TextDocument | undefined,
		newIssue: NewIssue | undefined,
		title: string,
		issueBody: string | undefined,
		assignees: string[] | undefined,
		labels: string[] | undefined,
		lineNumber: number | undefined,
		insertIndex: number | undefined,
		originUri?: vscode.Uri,
	): Promise<boolean> {
		let origin: PullRequestDefaults | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		if (document) {
			folderManager = this.manager.getManagerForFile(document.uri);
		} else if (originUri) {
			folderManager = this.manager.getManagerForFile(originUri);
		}
		if (!folderManager) {
			folderManager = await this.chooseRepo('Choose where to create the issue.');
		}

		if (!folderManager) {
			return false;
		}
		try {
			origin = await folderManager.getPullRequestDefaults();
		} catch (e) {
			// There is no remote
			vscode.window.showErrorMessage("There is no remote. Can't create an issue.");
			return false;
		}
		const body: string | undefined =
			issueBody || newIssue?.document.isUntitled
				? issueBody
				: (await createGithubPermalink(this.manager, this.gitAPI, newIssue)).permalink;
		const createParams: OctokitCommon.IssuesCreateParams = {
			owner: origin.owner,
			repo: origin.repo,
			title,
			body,
			assignees,
			labels,
		};
		if (!(await this.verifyLabels(folderManager, createParams))) {
			return false;
		}
		const issue = await folderManager.createIssue(createParams);
		if (issue) {
			if (document !== undefined && insertIndex !== undefined && lineNumber !== undefined) {
				const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
				const insertText: string =
					vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('createInsertFormat', 'number') ===
						'number'
						? `#${issue.number}`
						: issue.html_url;
				edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex), ` ${insertText}`);
				await vscode.workspace.applyEdit(edit);
			} else {
				const copyIssueUrl = 'Copy URL';
				const openIssue = 'Open Issue';
				vscode.window.showInformationMessage('Issue created', copyIssueUrl, openIssue).then(async result => {
					switch (result) {
						case copyIssueUrl:
							await vscode.env.clipboard.writeText(issue.html_url);
							break;
						case openIssue:
							await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
							break;
					}
				});
			}
			this._stateManager.refreshCacheNeeded();
			return true;
		}
		return false;
	}

	private async getPermalinkWithError(repositoriesManager: RepositoriesManager, fileUri?: vscode.Uri): Promise<PermalinkInfo> {
		const link = await createGithubPermalink(repositoriesManager, this.gitAPI, undefined, fileUri);
		if (link.error) {
			vscode.window.showWarningMessage(`Unable to create a GitHub permalink for the selection. ${link.error}`);
		}
		return link;
	}

	private async getHeadLinkWithError(fileUri?: vscode.Uri): Promise<PermalinkInfo> {
		const link = await createGitHubLink(this.manager, fileUri);
		if (link.error) {
			vscode.window.showWarningMessage(`Unable to create a GitHub link for the selection. ${link.error}`);
		}
		return link;
	}

	private async getContextualizedLink(file: vscode.Uri, link: string): Promise<string> {
		let uri: vscode.Uri;
		try {
			uri = await vscode.env.asExternalUri(file);
		} catch (e) {
			// asExternalUri can throw when in the browser and the embedder doesn't set a uri resolver.
			return link;
		}
		const authority = (uri.scheme === 'https' && /^(insiders\.vscode|vscode|github)\./.test(uri.authority)) ? uri.authority : undefined;
		if (!authority) {
			return link;
		}
		const linkUri = vscode.Uri.parse(link);
		const linkPath = /^(github)\./.test(uri.authority) ? linkUri.path : `/github${linkUri.path}`;
		return linkUri.with({ authority, path: linkPath }).toString();
	}

	async copyPermalink(repositoriesManager: RepositoriesManager, fileUri?: vscode.Uri) {
		const link = await this.getPermalinkWithError(repositoriesManager, fileUri);
		if (link.permalink) {
			return vscode.env.clipboard.writeText(
				link.originalFile ? (await this.getContextualizedLink(link.originalFile, link.permalink)) : link.permalink);
		}
	}

	async copyHeadLink(fileUri?: vscode.Uri) {
		const link = await this.getHeadLinkWithError(fileUri);
		if (link.permalink) {
			return vscode.env.clipboard.writeText(
				link.originalFile ? (await this.getContextualizedLink(link.originalFile, link.permalink)) : link.permalink);
		}
	}

	private getMarkdownLinkText(): string | undefined {
		if (!vscode.window.activeTextEditor) {
			return undefined;
		}
		let editorSelection: vscode.Range | undefined = vscode.window.activeTextEditor.selection;
		if (editorSelection.start.line !== editorSelection.end.line) {
			editorSelection = new vscode.Range(
				editorSelection.start,
				new vscode.Position(editorSelection.start.line + 1, 0),
			);
		}
		const selection = vscode.window.activeTextEditor.document.getText(editorSelection);
		if (selection) {
			return selection;
		}
		editorSelection = vscode.window.activeTextEditor.document.getWordRangeAtPosition(editorSelection.start);
		if (editorSelection) {
			return vscode.window.activeTextEditor.document.getText(editorSelection);
		}
		return undefined;
	}

	async copyMarkdownPermalink(repositoriesManager: RepositoriesManager) {
		const link = await this.getPermalinkWithError(repositoriesManager);
		const selection = this.getMarkdownLinkText();
		if (link.permalink && selection) {
			return vscode.env.clipboard.writeText(`[${selection.trim()}](${link.permalink})`);
		}
	}

	async openPermalink(repositoriesManager: RepositoriesManager) {
		const link = await this.getPermalinkWithError(repositoriesManager);
		if (link.permalink) {
			return vscode.env.openExternal(vscode.Uri.parse(link.permalink));
		}
		return undefined;
	}
}
