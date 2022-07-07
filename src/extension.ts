/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import { LiveShare } from 'vsls/vscode.js';
import { Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { registerCommands } from './commands';
import { commands } from './common/executeCommands';
import Logger from './common/logger';
import * as PersistentState from './common/persistentState';
import { Resource } from './common/resources';
import { SessionState } from './common/sessionState';
import { BRANCH_PUBLISH, FILE_LIST_LAYOUT, PR_SETTINGS_NAMESPACE } from './common/settingKeys';
import { TemporaryState } from './common/temporaryState';
import { Schemes, handler as uriHandler } from './common/uri';
import { EXTENSION_ID, FOCUS_REVIEW_MODE } from './constants';
import { createExperimentationService, ExperimentationTelemetry } from './experimentationService';
import { setSyncedKeys } from './extensionState';
import { CredentialStore } from './github/credentials';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from './github/folderRepositoryManager';
import { RepositoriesManager } from './github/repositoriesManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { GitLensIntegration } from './integrations/gitlens/gitlensImpl';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { getInMemPRFileSystemProvider } from './view/inMemPRContentProvider';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager, ShowPullRequest } from './view/reviewManager';
import { ReviewsManager } from './view/reviewsManager';
import { WebviewViewCoordinator } from './view/webviewViewCoordinator';

const aiKey = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

let telemetry: ExperimentationTelemetry;

const PROMPTS_SCOPE = 'prompts';
const PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY = 'createPROnPublish';

async function init(
	context: vscode.ExtensionContext,
	git: GitApiImpl,
	credentialStore: CredentialStore,
	repositories: Repository[],
	tree: PullRequestsTreeDataProvider,
	liveshareApiPromise: Promise<LiveShare | undefined>,
	showPRController: ShowPullRequest,
	reposManager: RepositoriesManager,
	folderManagers: FolderRepositoryManager[],
	sessionState: SessionState,
): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	vscode.authentication.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await reposManager.clearCredentialCache();
			if (reviewManagers) {
				reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
			}
		}
	});

	context.subscriptions.push(
		git.onDidPublish(async e => {
			// Only notify on branch publish events
			if (!e.branch) {
				return;
			}

			if (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'ask' | 'never' | undefined>(BRANCH_PUBLISH) !== 'ask') {
				return;
			}

			const reviewManager = reviewManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString(),
			);
			if (reviewManager?.isCreatingPullRequest) {
				return;
			}

			const folderManager = folderManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString());

			if (!folderManager || folderManager.gitHubRepositories.length === 0) {
				return;
			}

			const defaults = await folderManager.getPullRequestDefaults();
			if (defaults.base === e.branch) {
				return;
			}

			const create = 'Create Pull Request...';
			const dontShowAgain = "Don't Show Again";
			const result = await vscode.window.showInformationMessage(
				`Would you like to create a Pull Request for branch '${e.branch}'?`,
				create,
				dontShowAgain,
			);
			if (result === create) {
				reviewManager?.createPullRequest(e.branch);
			} else if (result === dontShowAgain) {
				await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(BRANCH_PUBLISH, 'never', vscode.ConfigurationTarget.Global);
			}
		}),
	);

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

	// Sort the repositories to match folders in a multiroot workspace (if possible).
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		repositories = repositories.sort((a, b) => {
			let indexA = workspaceFolders.length;
			let indexB = workspaceFolders.length;
			for (let i = 0; i < workspaceFolders.length; i++) {
				if (workspaceFolders[i].uri.toString() === a.rootUri.toString()) {
					indexA = i;
				} else if (workspaceFolders[i].uri.toString() === b.rootUri.toString()) {
					indexB = i;
				}
				if (indexA !== workspaceFolders.length && indexB !== workspaceFolders.length) {
					break;
				}
			}
			return indexA - indexB;
		});
	}

	liveshareApiPromise.then(api => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});

	const changesTree = new PullRequestChangesTreeDataProvider(context, git, reposManager);
	context.subscriptions.push(changesTree);

	const activePrViewCoordinator = new WebviewViewCoordinator(context);
	const reviewManagers = folderManagers.map(
		folderManager => new ReviewManager(context, folderManager.repository, folderManager, telemetry, changesTree, showPRController, sessionState, activePrViewCoordinator),
	);
	context.subscriptions.push(new FileTypeDecorationProvider(reposManager, reviewManagers));

	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, credentialStore, git);
	context.subscriptions.push(reviewsManager);

	git.onDidChangeState(() => {
		Logger.appendLine(`Git initialization state changed: state=${git.state}`);
		reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
	});

	git.onDidOpenRepository(repo => {
		function addRepo() {
			// Make sure we don't already have a folder manager for this repo.
			const existing = reposManager.getManagerForFile(repo.rootUri);
			if (existing) {
				Logger.appendLine(`Repo ${repo.rootUri} has already been setup.`);
				return;
			}
			const newFolderManager = new FolderRepositoryManager(context, repo, telemetry, git, credentialStore, sessionState);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(
				context,
				newFolderManager.repository,
				newFolderManager,
				telemetry,
				changesTree,
				showPRController,
				sessionState,
				activePrViewCoordinator
			);
			reviewsManager.addReviewManager(newReviewManager);
			tree.refresh();
		}
		addRepo();
		const disposable = repo.state.onDidChange(() => {
			Logger.appendLine(`Repo state for ${repo.rootUri} changed.`);
			addRepo();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);
		reviewsManager.removeReviewManager(repo);
		tree.refresh();
	});

	tree.initialize(reposManager);

	setSyncedKeys(context);
	registerCommands(context, sessionState, reposManager, reviewManagers, telemetry, credentialStore, tree);

	const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');

	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	context.subscriptions.push(new GitLensIntegration());

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);

	const experimentationService = await createExperimentationService(context, telemetry);
	await experimentationService.initializePromise;
	await experimentationService.isCachedFlightEnabled('githubaa');

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	if (EXTENSION_ID === 'GitHub.vscode-pull-request-github-insiders') {
		const stable = vscode.extensions.getExtension('github.vscode-pull-request-github');
		if (stable !== undefined) {
			throw new Error(
				'GitHub Pull Requests and Issues Nightly cannot be used while GitHub Pull Requests and Issues is also installed. Please ensure that only one version of the extension is installed.',
			);
		}
	}

	const showPRController = new ShowPullRequest();
	vscode.commands.registerCommand('github.api.preloadPullRequest', async (shouldShow: boolean) => {
		await vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
		await commands.focusView('github:activePullRequest:welcome');
		showPRController.shouldShow = shouldShow;
	});
	const openDiff = vscode.workspace.getConfiguration('git').get('openDiffOnClick', true);
	await vscode.commands.executeCommand('setContext', 'openDiffOnClick', openDiff);

	// initialize resources
	Resource.initialize(context);
	Logger.debug('Creating API implementation.', 'Activation');
	const apiImpl = new GitApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new ExperimentationTelemetry(new TelemetryReporter(EXTENSION_ID, version, aiKey));
	context.subscriptions.push(telemetry);

	await deferredActivate(context, apiImpl, showPRController);

	return apiImpl;
}

async function doRegisterBuiltinGitProvider(context: vscode.ExtensionContext, credentialStore: CredentialStore, apiImpl: GitApiImpl): Promise<boolean> {
	const builtInGitProvider = await registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
		return true;
	}
	return false;
}

async function deferredActivate(context: vscode.ExtensionContext, apiImpl: GitApiImpl, showPRController: ShowPullRequest) {
	Logger.debug('Initializing state.', 'Activation');
	PersistentState.init(context);
	// Migrate from state to setting
	if (PersistentState.fetch(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY) === false) {
		await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(BRANCH_PUBLISH, 'never', vscode.ConfigurationTarget.Global);
		PersistentState.store(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY, true);
	}
	TemporaryState.init(context);
	Logger.debug('Creating credential store.', 'Activation');
	const credentialStore = new CredentialStore(telemetry, context);
	context.subscriptions.push(credentialStore);
	await credentialStore.create({ silent: true });

	Logger.debug('Registering built in git provider.', 'Activation');
	if (!(await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl))) {
		const extensionsChangedDisposable = vscode.extensions.onDidChange(async () => {
			if (await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl)) {
				extensionsChangedDisposable.dispose();
			}
		});
		context.subscriptions.push(extensionsChangedDisposable);
	}

	Logger.debug('Registering live share git provider.', 'Activation');
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.debug('Creating tree view.', 'Activation');
	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);
	Logger.appendLine('Looking for git repository');
	const repositories = apiImpl.repositories;
	Logger.appendLine(`Found ${repositories.length} repositories during activation`);

	const sessionState = new SessionState(context);
	const folderManagers = repositories.map(
		repository => new FolderRepositoryManager(context, repository, telemetry, apiImpl, credentialStore, sessionState),
	);
	context.subscriptions.push(...folderManagers);

	const reposManager = new RepositoriesManager(folderManagers, credentialStore, telemetry, sessionState);
	context.subscriptions.push(reposManager);
	const inMemPRFileSystemProvider = getInMemPRFileSystemProvider({ reposManager, gitAPI: apiImpl, credentialStore })!;
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(Schemes.Pr, inMemPRFileSystemProvider, { isReadonly: true }));

	await init(context, apiImpl, credentialStore, repositories, prTree, liveshareApiPromise, showPRController, reposManager, folderManagers, sessionState);
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
