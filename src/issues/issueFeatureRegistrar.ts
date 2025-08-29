/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'path';
import * as vscode from 'vscode';
import { Remote } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import {
	ALWAYS_PROMPT_FOR_NEW_ISSUE_REPO,
	CREATE_INSERT_FORMAT,
	ENABLED,
	ISSUE_COMPLETIONS,
	ISSUES_SETTINGS_NAMESPACE,
	USER_COMPLETIONS,
} from '../common/settingKeys';
import { editQuery } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { fromRepoUri, RepoUriParams, Schemes, toNewIssueUri } from '../common/uri';
import { EXTENSION_ID } from '../constants';
import { OctokitCommon } from '../github/common';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IProject } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { IssueOverviewPanel } from '../github/issueOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput } from '../github/utils';
import { chatCommand } from '../lm/utils';
import { ReviewManager } from '../view/reviewManager';
import { ReviewsManager } from '../view/reviewsManager';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { CurrentIssue } from './currentIssue';
import { IssueCompletionProvider } from './issueCompletionProvider';
import {
	ASSIGNEES,
	extractMetadataFromFile,
	IssueFileSystemProvider,
	LABELS,
	MILESTONE,
	NewIssueCache,
	NewIssueFileCompletionProvider,
	NewIssueFileOptions,
	PROJECTS,
} from './issueFile';
import { IssueHoverProvider } from './issueHoverProvider';
import { openCodeLink } from './issueLinkLookup';
import { IssuesTreeData, QueryNode, updateExpandedQueries } from './issuesView';
import { IssueTodoProvider } from './issueTodoProvider';
import { ShareProviderManager } from './shareProviders';
import { StateManager } from './stateManager';
import { UserCompletionProvider } from './userCompletionProvider';
import { UserHoverProvider } from './userHoverProvider';
import {
	createGitHubLink,
	createGithubPermalink,
	createSinglePermalink,
	getIssue,
	IssueTemplate,
	LinkContext,
	NewIssue,
	PERMALINK_COMPONENT,
	PermalinkInfo,
	pushAndCreatePR,
	USER_EXPRESSION,
} from './util';

const CREATING_ISSUE_FROM_FILE_CONTEXT = 'issues.creatingFromFile';

export class IssueFeatureRegistrar extends Disposable {
	private static readonly ID = 'IssueFeatureRegistrar';
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
		private reviewsManager: ReviewsManager,
		private context: vscode.ExtensionContext,
		private telemetry: ITelemetry,
		private copilotRemoteAgentManager: CopilotRemoteAgentManager,
	) {
		super();
		this._stateManager = new StateManager(gitAPI, this.manager, this.context);
		this._newIssueCache = new NewIssueCache(context);
	}

	async initialize() {
		this._register(vscode.workspace.registerFileSystemProvider(Schemes.NewIssue, new IssueFileSystemProvider(this._newIssueCache)));
		this._register(
			vscode.languages.registerCompletionItemProvider(
				{ scheme: Schemes.NewIssue },
				new NewIssueFileCompletionProvider(this.manager),
				' ',
				',',
			),
		);
		const view = vscode.window.createTreeView('issues:github', {
			showCollapseAll: true,
			treeDataProvider: new IssuesTreeData(this._stateManager, this.manager, this.context),
		});
		this._register(view);
		this._register(view.onDidCollapseElement(e => updateExpandedQueries(this.context, e.element, false)));
		this._register(view.onDidExpandElement(e => updateExpandedQueries(this.context, e.element, true)));
		this._register(
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
		this._register(
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
		this._register(
			vscode.commands.registerCommand(
				'issue.startCodingAgentFromTodo',
				(todoInfo?: { document: vscode.TextDocument; lineNumber: number; line: string; insertIndex: number; range: vscode.Range }) => {
					/* __GDPR__
				"issue.startCodingAgentFromTodo" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.startCodingAgentFromTodo');
					return this.startCodingAgentFromTodo(todoInfo);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.assignToCodingAgent',
				(issueModel: any) => {
					/* __GDPR__
				"issue.assignToCodingAgent" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.assignToCodingAgent');
					return this.assignToCodingAgent(issueModel);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubPermalink',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubPermalink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubPermalink');
					return this.copyPermalink(this.manager, additional && additional.length > 0 ? additional : [context]);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubHeadLink',
				(fileUri: vscode.Uri, additional: vscode.Uri[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubHeadLink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubHeadLink');
					return this.copyHeadLink(additional && additional.length > 0 ? additional : [fileUri]);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubPermalinkWithoutRange',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubPermalinkWithoutRange" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubPermalinkWithoutRange');
					return this.copyPermalink(this.manager, additional && additional.length > 0 ? additional : [context], false);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubHeadLinkWithoutRange',
				(fileUri: vscode.Uri, additional: vscode.Uri[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubHeadLinkWithoutRange" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubHeadLinkWithoutRange');
					return this.copyHeadLink(additional && additional.length > 0 ? additional : [fileUri], false);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubDevLinkWithoutRange',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubDevLinkWithoutRange" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubDevLinkWithoutRange');
					return this.copyPermalink(this.manager, additional && additional.length > 0 ? additional : [context], false, true, true);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubDevLink',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubDevLink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubDevLink');
					return this.copyPermalink(this.manager, additional && additional.length > 0 ? additional : [context], true, true, true);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyGithubDevLinkFile',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyGithubDevLinkFile" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyGithubDevLinkFile');
					return this.copyPermalink(this.manager, additional && additional.length > 0 ? additional : [context], false, true, true);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyMarkdownGithubPermalink',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyMarkdownGithubPermalink" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyMarkdownGithubPermalink');
					return this.copyMarkdownPermalink(this.manager, additional && additional.length > 0 ? additional : [context]);
				},
				this,
			),
		);
		this._register(
			vscode.commands.registerCommand(
				'issue.copyMarkdownGithubPermalinkWithoutRange',
				(context: LinkContext, additional: LinkContext[] | undefined) => {
					/* __GDPR__
				"issue.copyMarkdownGithubPermalinkWithoutRange" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.copyMarkdownGithubPermalinkWithoutRange');
					return this.copyMarkdownPermalink(this.manager, additional && additional.length > 0 ? additional : [context], false);
				},
				this,
			),
		);
		this._register(
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
		this._register(new ShareProviderManager(this.manager, this.gitAPI));
		this._register(
			vscode.commands.registerCommand('issue.openIssue', (issueModel: any) => {
				/* __GDPR__
				"issue.openIssue" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.openIssue');
				return this.openIssue(issueModel);
			}),
		);
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
			vscode.commands.registerCommand('issue.copyIssueNumber', (issueModel: any) => {
				/* __GDPR__
				"issue.copyIssueNumber" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.copyIssueNumber');
				return this.copyIssueNumber(issueModel);
			}),
		);
		this._register(
			vscode.commands.registerCommand('issue.copyIssueUrl', (issueModel: any) => {
				/* __GDPR__
				"issue.copyIssueUrl" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.copyIssueUrl');
				return this.copyIssueUrl(issueModel);
			}),
		);
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
			vscode.commands.registerCommand(
				'issue.editQuery',
				(query: QueryNode) => {
					/* __GDPR__
				"issue.editQuery" : {}
			*/
					this.telemetry.sendTelemetryEvent('issue.editQuery');
					return editQuery(ISSUES_SETTINGS_NAMESPACE, query.queryLabel);
				},
				this,
			),
		);
		this._register(
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
		this._register(
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
		this._register(
			vscode.commands.registerCommand('issue.issueCompletion', () => {
				/* __GDPR__
				"issue.issueCompletion" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.issueCompletion');
			}),
		);
		this._register(
			vscode.commands.registerCommand('issue.userCompletion', () => {
				/* __GDPR__
				"issue.userCompletion" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.userCompletion');
			}),
		);
		this._register(
			vscode.commands.registerCommand('issue.signinAndRefreshList', async () => {
				return this.manager.authenticate();
			}),
		);
		this._register(
			vscode.commands.registerCommand('issue.goToLinkedCode', async (issueModel: any) => {
				return openCodeLink(issueModel, this.manager);
			}),
		);
		const chatCommandID = chatCommand();
		this._register(
			vscode.commands.registerCommand('issue.chatSummarizeIssue', (issue: any) => {
				if (!(issue instanceof IssueModel || issue instanceof PRNode)) {
					return;
				}
				/* __GDPR__
				"issue.chatSummarizeIssue" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.chatSummarizeIssue');
				if (issue instanceof IssueModel) {
					commands.executeCommand(chatCommandID, vscode.l10n.t('@githubpr Summarize issue {0}/{1}#{2}', issue.remote.owner, issue.remote.repositoryName, issue.number));
				} else {
					const pullRequestModel = issue.pullRequestModel;
					const remote = pullRequestModel.githubRepository.remote;
					commands.executeCommand(chatCommandID, vscode.l10n.t('@githubpr Summarize pull request {0}/{1}#{2}', remote.owner, remote.repositoryName, pullRequestModel.number));
				}
			}),
		);
		this._register(
			vscode.commands.registerCommand('issue.chatSuggestFix', (issue: any) => {
				if (!(issue instanceof IssueModel)) {
					return;
				}
				/* __GDPR__
				"issue.chatSuggestFix" : {}
			*/
				this.telemetry.sendTelemetryEvent('issue.chatSuggestFix');
				commands.executeCommand(chatCommandID, vscode.l10n.t('@githubpr Find a fix for issue {0}/{1}#{2}', issue.remote.owner, issue.remote.repositoryName, issue.number));
			}),
		);
		this._register(vscode.commands.registerCommand('issues.configureIssuesViewlet', async () => {
			/* __GDPR__
				"issues.configureIssuesViewlet" : {}
			*/
			return vscode.commands.executeCommand(
				'workbench.action.openSettings',
				`@ext:${EXTENSION_ID} issues`,
			);
		}));
		this._stateManager.tryInitializeAndWait().then(() => {
			this.registerCompletionProviders();

			this._register(
				vscode.languages.registerHoverProvider(
					'*',
					new IssueHoverProvider(this.manager, this._stateManager, this.context, this.telemetry),
				),
			);
			this._register(
				vscode.languages.registerHoverProvider('*', new UserHoverProvider(this.manager, this.telemetry)),
			);
			this._register(
				vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider(this.context, this.copilotRemoteAgentManager), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
			);
		});
	}

	private documentFilters: Array<vscode.DocumentFilter | string> = [
		{ language: 'php' },
		{ language: 'powershell' },
		{ language: 'jade' },
		{ language: 'python' },
		{ language: 'r' },
		{ language: 'razor' },
		{ language: 'ruby' },
		{ language: 'rust' },
		{ language: 'scminput' },
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
					configuration: `${ISSUE_COMPLETIONS}.${ENABLED}`,
				},
				{
					provider: UserCompletionProvider,
					trigger: '@',
					disposable: undefined,
					configuration: `${USER_COMPLETIONS}.${ENABLED}`,
				},
			];
		for (const element of providers) {
			if (vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(element.configuration, true)) {
				this._register(
					(element.disposable = vscode.languages.registerCompletionItemProvider(
						this.documentFilters,
						new element.provider(this._stateManager, this.manager, this.context),
						element.trigger,
					)),
				);
			}
		}
		this._register(
			vscode.workspace.onDidChangeConfiguration(change => {
				for (const element of providers) {
					if (change.affectsConfiguration(`${ISSUES_SETTINGS_NAMESPACE}.${element.configuration}`)) {
						const newValue: boolean = vscode.workspace
							.getConfiguration(ISSUES_SETTINGS_NAMESPACE)
							.get(element.configuration, true);
						if (!newValue && element.disposable) {
							element.disposable.dispose();
							element.disposable = undefined;
						} else if (newValue && !element.disposable) {
							this._register(
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
		let folderManager: FolderRepositoryManager | undefined = uri ? this.manager.getManagerForFile(uri) : undefined;

		const alwaysPrompt = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get<boolean>(ALWAYS_PROMPT_FOR_NEW_ISSUE_REPO);
		if (!folderManager || alwaysPrompt) {
			folderManager = await this.chooseRepo(vscode.l10n.t('Select the repo to create the issue in.'));
			uri = folderManager?.repository.rootUri;
		}
		if (!folderManager || !uri) {
			return;
		}

		const template = await this.chooseTemplate(folderManager);
		this._newIssueCache.clear();

		const remoteName = folderManager.repository.state.HEAD?.upstream?.remote;
		let remote = remoteName ? folderManager.repository.state.remotes.find(r => r.name === remoteName) : undefined;

		if (!remote) {
			const potentialRemotes = folderManager.repository.state.remotes.filter(r => r.fetchUrl || r.pushUrl);
			interface RemoteChoice extends vscode.QuickPickItem {
				remote: Remote;
			}
			const choices: RemoteChoice[] = potentialRemotes.map(remote => ({
				label: `${remote.name}: ${remote.fetchUrl || remote.pushUrl}`,
				remote,
			}));

			const choice = await vscode.window.showQuickPick(choices, { placeHolder: vscode.l10n.t('Select a remote to file this issue to') });
			if (!choice) {
				return;
			}
			remote = choice.remote;
		}

		let options: NewIssueFileOptions = { remote };
		if (template) {
			options = {
				...options,
				title: template.title,
				body: template.body,
			};
		}
		this.makeNewIssueFile(uri, options);
	}

	async createIssueFromFile() {
		const metadata = await extractMetadataFromFile(this.manager);
		if (!metadata || !vscode.window.activeTextEditor) {
			return;
		}
		const createSucceeded = await this.doCreateIssue(
			this.createIssueInfo?.document,
			this.createIssueInfo?.newIssue,
			metadata.title,
			metadata.body,
			metadata.assignees,
			metadata.labels,
			metadata.milestone,
			metadata.projects,
			this.createIssueInfo?.lineNumber,
			this.createIssueInfo?.insertIndex,
			metadata.originUri
		);
		this.createIssueInfo = undefined;
		if (createSucceeded && vscode.window.tabGroups.activeTabGroup.activeTab) {
			await vscode.window.activeTextEditor.document.save();
			await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab);
			this._newIssueCache.clear();
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
			repoManager = await this.chooseRepo(vscode.l10n.t('Choose which repository you want to work on this isssue in.'));
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
			true
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
			folderManager = await this.chooseRepo(vscode.l10n.t('Choose which repository you want to stop working on this issue in.'));
			if (!folderManager) {
				return;
			}
		}
		if (
			issueModel instanceof IssueModel &&
			this._stateManager.currentIssue(folderManager.repository.rootUri)?.issue.number === issueModel.number
		) {
			await this._stateManager.setCurrentIssue(folderManager, undefined, true);
		}
	}

	private async statusBarActions(currentIssue: CurrentIssue) {
		const openIssueText: string = vscode.l10n.t('{0} Open #{1} {2}', '$(globe)', currentIssue.issue.number, currentIssue.issue.title);
		const pullRequestText: string = vscode.l10n.t({ message: '{0} Create pull request for #{1} (pushes branch)', args: ['$(git-pull-request)', currentIssue.issue.number], comment: ['The first placeholder is an icon and shouldn\'t be localized', 'The second placeholder is the ID number of a GitHub Issue.'] });
		let defaults: PullRequestDefaults | undefined;
		try {
			defaults = await currentIssue.manager.getPullRequestDefaults();
		} catch (e) {
			// leave defaults undefined
		}
		const stopWorkingText: string = vscode.l10n.t('{0} Stop working on #{1}', '$(primitive-square)', currentIssue.issue.number);
		const choices =
			currentIssue.branchName && defaults
				? [openIssueText, pullRequestText, stopWorkingText]
				: [openIssueText, pullRequestText, stopWorkingText];
		const response: string | undefined = await vscode.window.showQuickPick(choices, {
			placeHolder: vscode.l10n.t('Current issue options'),
		});
		switch (response) {
			case openIssueText:
				return this.openIssue(currentIssue.issue);
			case pullRequestText: {
				const reviewManager = ReviewManager.getReviewManagerForFolderManager(
					this.reviewsManager.reviewManagers,
					currentIssue.manager,
				);
				if (reviewManager) {
					return pushAndCreatePR(currentIssue.manager, reviewManager, this._stateManager);
				}
				break;
			}
			case stopWorkingText:
				return this._stateManager.setCurrentIssue(currentIssue.manager, undefined, true);
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
					label: vscode.l10n.t('#{0} from {1}', currentIssue.issue.number, `${currentIssue.issue.githubRepository.remote.owner}/${currentIssue.issue.githubRepository.remote.repositoryName}`),
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
			const folderRepoManager = this.manager.getManagerForFile(newIssue.document.uri);
			const changeAffectingFile = folderRepoManager?.repository?.state.workingTreeChanges.find(value => value.uri.toString() === newIssue.document.uri.toString());
			if (changeAffectingFile) {
				// The file we're creating the issue for has uncommitted changes.
				// Add a quote of the line so that the issue body is still meaningful.
				contents = `\`\`\`\n${newIssue.line}\n\`\`\`\n\n`;
			}

			if (folderRepoManager) {
				const relativePath = folderRepoManager.gitRelativeRootPath(newIssue.document.uri.path);
				contents += vscode.l10n.t('In file {0}\n', relativePath);
			}
		}

		contents += (await createSinglePermalink(this.manager, this.gitAPI, true, true, newIssue)).permalink;
		return contents;
	}

	async createTodoIssue(newIssue?: NewIssue, issueBody?: string) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		let assignees: string[] | undefined;
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
			assignees = [matches[1]];
		}
		let title: string | undefined;
		const body: string | undefined = await this.createTodoIssueBody(newIssue, issueBody);

		const quickInput = vscode.window.createInputBox();
		quickInput.value = titlePlaceholder ?? '';
		quickInput.prompt =
			vscode.l10n.t('Set the issue title. Confirm to create the issue now or use the edit button to edit the issue title and description.');
		quickInput.title = vscode.l10n.t('Create Issue');
		quickInput.buttons = [
			{
				iconPath: new vscode.ThemeIcon('edit'),
				tooltip: vscode.l10n.t('Edit Description'),
			},
		];
		quickInput.onDidAccept(async () => {
			title = quickInput.value;
			if (title) {
				quickInput.busy = true;
				await this.doCreateIssue(document, newIssue, title, body, assignees, undefined, undefined, undefined, lineNumber, insertIndex);
				quickInput.busy = false;
			}
			quickInput.hide();
		});
		quickInput.onDidTriggerButton(async () => {
			title = quickInput.value;
			quickInput.busy = true;
			this.createIssueInfo = { document, newIssue, lineNumber, insertIndex };

			this.makeNewIssueFile(document.uri, { title, body, assignees });
			quickInput.busy = false;
			quickInput.hide();
		});
		quickInput.show();

		return undefined;
	}

	private async makeNewIssueFile(
		originUri: vscode.Uri,
		options?: NewIssueFileOptions
	) {
		const folderManager = this.manager.getManagerForFile(originUri);
		if (!folderManager) {
			return;
		}
		const repoRef = folderManager.findRepo((githubRepo) => githubRepo.remote.remoteName === options?.remote?.name)?.remote.gitProtocol;
		const repoUrl = repoRef?.url.toString().endsWith('.git') ? repoRef?.url.toString().slice(0, -4) : repoRef?.url.toString();
		const repoUriParams: RepoUriParams | undefined = repoRef ? { owner: repoRef?.owner, repo: repoRef?.repositoryName, repoRootUri: folderManager.repository.rootUri } : undefined;
		const bodyPath = toNewIssueUri({ originUri, repoUriParams });
		if (
			vscode.window.visibleTextEditors.filter(
				visibleEditor => visibleEditor.document.uri.scheme === Schemes.NewIssue,
			).length > 0
		) {
			return;
		}
		await vscode.workspace.fs.delete(bodyPath);
		const assigneeLine = `${ASSIGNEES} ${options?.assignees && options.assignees.length > 0 ? options.assignees.map(value => '@' + value).join(', ') + ' ' : ''
			}`;
		const labelLine = `${LABELS} `;
		const milestoneLine = `${MILESTONE} `;
		const projectsLine = `${PROJECTS} `;
		const cached = this._newIssueCache.get();
		const text = (cached && cached !== '') ? cached : `${options?.title ?? vscode.l10n.t('Issue Title')}\n
${repoRef ? `<!-- ${vscode.l10n.t('This issue will be created in repo {0} ({1}). Changing this line has no effect.', repoRef.nameWithOwner, repoUrl!)} -->\n` : ''}
${assigneeLine}
${labelLine}
${milestoneLine}
${projectsLine}\n
${options?.body ?? ''}\n
<!-- ${vscode.l10n.t('Edit the body of your new issue then click the ✓ \"Create Issue\" button in the top right of the editor. The first line will be the issue title. Assignees and Labels follow after a blank line. Leave an empty line before beginning the body of the issue.')} -->`;
		await vscode.workspace.fs.writeFile(bodyPath, this.stringToUint8Array(text));
		const assigneesDecoration = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: vscode.l10n.t(' Comma-separated usernames, either @username or just username.'),
				fontStyle: 'italic',
				color: new vscode.ThemeColor('issues.newIssueDecoration'),
			},
		});
		const labelsDecoration = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: vscode.l10n.t(' Comma-separated labels.'),
				fontStyle: 'italic',
				color: new vscode.ThemeColor('issues.newIssueDecoration'),
			},
		});
		const projectsDecoration = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: vscode.l10n.t(' Comma-separated projects.'),
				fontStyle: 'italic',
				color: new vscode.ThemeColor('issues.newIssueDecoration'),
			},
		});
		const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(textEditor => {
			if (textEditor?.document.uri.scheme === Schemes.NewIssue) {
				const metadataFirstLine = repoRef ? 4 : 2;
				const assigneeLineNum = metadataFirstLine + 0;
				const labelLineNum = metadataFirstLine + 1;
				const projectsLineNum = metadataFirstLine + 3;
				const assigneeFullLine = textEditor.document.lineAt(assigneeLineNum);
				if (assigneeFullLine.text.startsWith(ASSIGNEES)) {
					textEditor.setDecorations(assigneesDecoration, [
						new vscode.Range(
							new vscode.Position(assigneeLineNum, 0),
							new vscode.Position(assigneeLineNum, assigneeFullLine.text.length),
						),
					]);
				}
				const labelFullLine = textEditor.document.lineAt(labelLineNum);
				if (labelFullLine.text.startsWith(LABELS)) {
					textEditor.setDecorations(labelsDecoration, [
						new vscode.Range(new vscode.Position(labelLineNum, 0), new vscode.Position(labelLineNum, labelFullLine.text.length)),
					]);
				}
				const projectsFullLine = textEditor.document.lineAt(projectsLineNum);
				if (projectsFullLine.text.startsWith(PROJECTS)) {
					textEditor.setDecorations(projectsDecoration, [
						new vscode.Range(new vscode.Position(projectsLineNum, 0), new vscode.Position(projectsLineNum, projectsFullLine.text.length)),
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
			const yes = vscode.l10n.t('Yes');
			const no = vscode.l10n.t('No');
			const promptResult = await vscode.window.showInformationMessage(
				vscode.l10n.t('The following labels don\'t exist in this repository: {0}. \nDo you want to create these labels?', newLabels.join(
					', ',
				)),
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

	private async chooseTemplate(folderManager: FolderRepositoryManager): Promise<{ title: string | undefined, body: string | undefined } | undefined> {
		const templateUris = await folderManager.getIssueTemplates();
		if (templateUris.length === 0) {
			return { title: undefined, body: undefined };
		}

		interface IssueChoice extends vscode.QuickPickItem {
			template: { title: string | undefined, body: string | undefined } | undefined;
		}
		const templates = await Promise.all(
			templateUris
				.map(async uri => {
					try {
						const content = await vscode.workspace.fs.readFile(uri);
						const text = new TextDecoder('utf-8').decode(content);
						const template = this.getDataFromTemplate(text);

						return template;
					} catch (e) {
						Logger.warn(`Reading issue template failed: ${e}`);
						return undefined;
					}
				})
		);
		const choices: IssueChoice[] = templates.filter(template => !!template && !!template?.name).map(template => {
			return {
				label: template!.name!,
				description: template!.about,
				template: template,
			};
		});
		choices.push({
			label: vscode.l10n.t('Blank issue'),
			template: { title: undefined, body: undefined }
		});

		const selectedTemplate = await vscode.window.showQuickPick(choices, {
			placeHolder: vscode.l10n.t('Select a template for the new issue.'),
		});

		return selectedTemplate?.template;
	}

	private getDataFromTemplate(template: string): IssueTemplate {
		const title = template.match(/title:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
		const name = template.match(/name:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
		const about = template.match(/about:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
		const body = template.match(/---([\s\S]*)---([\s\S]*)/)?.[2];
		return { title, name, about, body };
	}

	private async doCreateIssue(
		document: vscode.TextDocument | undefined,
		newIssue: NewIssue | undefined,
		title: string,
		issueBody: string | undefined,
		assignees: string[] | undefined,
		labels: string[] | undefined,
		milestone: number | undefined,
		projects: IProject[] | undefined,
		lineNumber: number | undefined,
		insertIndex: number | undefined,
		originUri?: vscode.Uri
	): Promise<boolean> {
		let origin: PullRequestDefaults | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		if (originUri && originUri.scheme === Schemes.Repo) {
			const repoUriParams = fromRepoUri(originUri);
			if (repoUriParams) {
				origin = { owner: repoUriParams.owner, repo: repoUriParams.repo, base: '' };
				folderManager = this.manager.getManagerForFile(repoUriParams.repoRootUri);
			}
			if (!folderManager) {
				vscode.window.showErrorMessage(vscode.l10n.t(`Could not find the correct repository for the issue; see logs for more details.`));
				Logger.error(`Could not find the folder manager for the issue originUri: ${originUri.toString()}`, IssueFeatureRegistrar.ID);
				return false;
			}
		}

		if (!folderManager) {
			// We don't check for githubIssues.alwaysPromptForNewIssueRepo here because we're
			// likely in this scenario due to making an issue from a file selection/etc.
			if (document) {
				folderManager = this.manager.getManagerForFile(document.uri);
			} else if (originUri) {
				folderManager = this.manager.getManagerForFile(originUri);
			}
		}
		if (!folderManager) {
			folderManager = await this.chooseRepo(vscode.l10n.t('Choose where to create the issue.'));
		}

		const assigneesWithoutCopilot = assignees?.filter(assignee => !COPILOT_ACCOUNTS[assignee]);
		const copilotAssignee = !!assignees?.find(assignee => COPILOT_ACCOUNTS[assignee]);

		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating issue') }, async (progress) => {
			if (!folderManager) {
				return false;
			}
			const constFolderManager: FolderRepositoryManager = folderManager;
			progress.report({ message: vscode.l10n.t('Verifying that issue data is valid...') });
			try {
				if (!origin) {
					origin = await constFolderManager.getPullRequestDefaults();
				}
			} catch (e) {
				// There is no remote
				vscode.window.showErrorMessage(vscode.l10n.t('There is no remote. Can\'t create an issue.'));
				return false;
			}
			const body: string | undefined =
				issueBody || newIssue?.document.isUntitled
					? issueBody
					: (await createSinglePermalink(this.manager, this.gitAPI, true, true, newIssue)).permalink;
			const createParams: OctokitCommon.IssuesCreateParams = {
				owner: origin.owner,
				repo: origin.repo,
				title,
				body,
				assignees: assigneesWithoutCopilot,
				labels,
				milestone
			};

			if (!(await this.verifyLabels(constFolderManager, createParams))) {
				return false;
			}
			progress.report({ message: vscode.l10n.t('Creating issue in {0}...', `${createParams.owner}/${createParams.repo}`) });
			const issue = await constFolderManager.createIssue(createParams);
			if (issue) {
				if (copilotAssignee) {
					const copilotUser = (await folderManager.getAssignableUsers())[issue.remote.remoteName].find(user => COPILOT_ACCOUNTS[user.login]);
					if (copilotUser) {
						await issue.replaceAssignees([...(issue.assignees ?? []), copilotUser]);
					}
				}
				if (projects) {
					await issue.updateProjects(projects);
				}
				if (document !== undefined && insertIndex !== undefined && lineNumber !== undefined) {
					const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
					const insertText: string =
						vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(CREATE_INSERT_FORMAT, 'number') ===
							'number'
							? `#${issue.number}`
							: issue.html_url;
					edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex), ` ${insertText}`);
					await vscode.workspace.applyEdit(edit);
				} else {
					const copyIssueUrl = vscode.l10n.t('Copy Issue Link');
					const openIssue = vscode.l10n.t({ message: 'Open Issue', comment: 'Open the issue description in the editor to see it\'s full contents.' });
					vscode.window.showInformationMessage(vscode.l10n.t('Issue created'), copyIssueUrl, openIssue).then(async result => {
						switch (result) {
							case copyIssueUrl:
								await vscode.env.clipboard.writeText(issue.html_url);
								break;
							case openIssue:
								await IssueOverviewPanel.createOrShow(this.telemetry, this.context.extensionUri, constFolderManager, issue);
								break;
						}
					});
				}
				this._stateManager.refreshCacheNeeded();
				return true;
			}
			return false;
		});
	}

	private async getPermalinkWithError(repositoriesManager: RepositoriesManager, includeRange: boolean, includeFile: boolean, context?: LinkContext[]): Promise<PermalinkInfo[]> {
		const links = await createGithubPermalink(repositoriesManager, this.gitAPI, includeRange, includeFile, undefined, context);
		const firstError = links.find(link => link.error);
		if (firstError) {
			vscode.window.showWarningMessage(vscode.l10n.t('Unable to create a GitHub permalink for the selection. {0}', firstError.error!));
		}
		return links;
	}

	private async getHeadLinkWithError(context?: vscode.Uri[], includeRange?: boolean): Promise<PermalinkInfo[]> {
		const links = await createGitHubLink(this.manager, context, includeRange);
		if (links.length > 0) {
			const firstError = links.find(link => link.error);
			if (firstError) {
				vscode.window.showWarningMessage(vscode.l10n.t('Unable to create a GitHub link for the selection. {0}', firstError.error!));
			}
		}
		return links;
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

	private async permalinkInfoToClipboardText(links: PermalinkInfo[], shouldContextualize: boolean = false): Promise<string | undefined> {
		const withPermalinks: (PermalinkInfo & { permalink: string })[] = links.filter((link): link is PermalinkInfo & { permalink: string } => !!link.permalink);
		if (withPermalinks.length !== 0) {
			const contextualizedLinks = await Promise.all(withPermalinks.map(async link => (shouldContextualize && link.originalFile) ? await this.getContextualizedLink(link.originalFile, link.permalink) : link.permalink));
			const clipboardText = contextualizedLinks.join('\n');
			Logger.debug(`Will write ${clipboardText} to the clipboard`, PERMALINK_COMPONENT);
			return clipboardText;
		}
		return undefined;
	}

	async copyPermalink(repositoriesManager: RepositoriesManager, context?: LinkContext[], includeRange: boolean = true, includeFile: boolean = true, contextualizeLink: boolean = false) {
		const links = await this.getPermalinkWithError(repositoriesManager, includeRange, includeFile, context);
		const clipboardText = await this.permalinkInfoToClipboardText(links, contextualizeLink);
		if (clipboardText) {
			return vscode.env.clipboard.writeText(clipboardText);
		}
	}

	async copyHeadLink(fileUri?: vscode.Uri[], includeRange = true) {
		const link = await this.getHeadLinkWithError(fileUri, includeRange);
		const clipboardText = await this.permalinkInfoToClipboardText(link);
		if (clipboardText) {
			return vscode.env.clipboard.writeText(clipboardText);
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

	async copyMarkdownPermalink(repositoriesManager: RepositoriesManager, context: LinkContext[], includeRange: boolean = true) {
		const links = await this.getPermalinkWithError(repositoriesManager, includeRange, true, context);
		const withPermalinks: (PermalinkInfo & { permalink: string })[] = links.filter((link): link is PermalinkInfo & { permalink: string } => !!link.permalink);

		if (withPermalinks.length === 1) {
			const selection = this.getMarkdownLinkText();
			if (selection) {
				return vscode.env.clipboard.writeText(`[${selection.trim()}](${withPermalinks[0].permalink})`);
			}
		}
		const clipboardText = withPermalinks.map(link => `[${basename(link.originalFile?.fsPath ?? '')}](${link.permalink})`).join('\n');
		Logger.debug(`writing ${clipboardText} to the clipboard`, PERMALINK_COMPONENT);
		return vscode.env.clipboard.writeText(clipboardText);
	}

	async openPermalink(repositoriesManager: RepositoriesManager) {
		const links = await this.getPermalinkWithError(repositoriesManager, true, true);
		const withPermalinks: (PermalinkInfo & { permalink: string })[] = links.filter((link): link is PermalinkInfo & { permalink: string } => !!link.permalink);

		if (withPermalinks.length > 0) {
			return vscode.env.openExternal(vscode.Uri.parse(withPermalinks[0].permalink));
		}
		return undefined;
	}

	async startCodingAgentFromTodo(todoInfo?: { document: vscode.TextDocument; lineNumber: number; line: string; insertIndex: number; range: vscode.Range }) {
		if (!todoInfo) {
			return;
		}

		const { document, line, insertIndex } = todoInfo;

		// Extract the TODO text after the trigger word
		const todoText = line.substring(insertIndex).trim();

		if (!todoText) {
			vscode.window.showWarningMessage(vscode.l10n.t('No task description found in TODO comment'));
			return;
		}

		// Create a prompt for the coding agent
		const relativePath = vscode.workspace.asRelativePath(document.uri);
		const prompt = vscode.l10n.t('Work on TODO: {0} (from {1})', todoText, relativePath);

		// Start the coding agent session
		try {
			await this.copilotRemoteAgentManager.commandImpl({
				userPrompt: prompt,
				source: 'todo'
			});
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to start coding agent session: {0}', error.message));
		}
	}

	async assignToCodingAgent(issueModel: any) {
		if (!issueModel) {
			return;
		}

		// Check if the issue model is an IssueModel
		if (!(issueModel instanceof IssueModel)) {
			return;
		}

		// Create a prompt for the coding agent based on the issue
		const prompt = vscode.l10n.t('Work on GitHub issue #{0}: {1}', issueModel.number, issueModel.title);

		// Start the coding agent session
		try {
			await this.copilotRemoteAgentManager.commandImpl({
				userPrompt: prompt,
				source: 'issue'
			});
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to start coding agent session: {0}', error.message));
		}
	}
}
