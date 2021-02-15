/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import TelemetryReporter from 'vscode-extension-telemetry';
import { Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { onceEvent } from './common/utils';
import * as PersistentState from './common/persistentState';
import { EXTENSION_ID } from './constants';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { registerBuiltinGitProvider } from './gitProviders/api';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { CredentialStore } from './github/credentials';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { LiveShare } from 'vsls/vscode.js';
import { RepositoriesManager } from './github/repositoriesManager';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { ReviewsManager } from './view/reviewsManager';
import { registerLiveShareGitProvider } from './gitProviders/api';
import { GitLensIntegration } from './integrations/gitlens/gitlensImpl';
import { ExperimentationTelemetry } from './experimentationService';

const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: ExperimentationTelemetry;

const PROMPTS_SCOPE = 'prompts';
const PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY = 'createPROnPublish';

async function init(context: vscode.ExtensionContext, git: GitApiImpl, credentialStore: CredentialStore, repositories: Repository[], tree: PullRequestsTreeDataProvider, liveshareApiPromise: Promise<LiveShare | undefined>): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	vscode.authentication.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await reposManager.clearCredentialCache();
			if (reviewManagers) {
				reviewManagers.forEach(reviewManager => reviewManager.updateState());
			}
		}
	});

	context.subscriptions.push(git.onDidPublish(async e => {
		// Only notify on branch publish events
		if (!e.branch || PersistentState.fetch(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY) === false) {
			return;
		}

		const reviewManager = reviewManagers.find(manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString());
		if (reviewManager?.isCreatingPullRequest) {
			return;
		}

		const create = 'Create Pull Request...';
		const dontShowAgain = 'Don\'t Show Again';
		const result = await vscode.window.showInformationMessage(`Would you like to create a Pull Request for branch '${e.branch}'?`, create, dontShowAgain);
		if (result === create) {
			void vscode.commands.executeCommand('pr.create');
		} else if (result === dontShowAgain) {
			PersistentState.store(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY, false);
		}
	}));

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());
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
	const folderManagers = repositories.map(repository => new FolderRepositoryManager(repository, telemetry, git, credentialStore));
	context.subscriptions.push(...folderManagers);
	const reposManager = new RepositoriesManager(folderManagers, credentialStore, telemetry);
	context.subscriptions.push(reposManager);

	liveshareApiPromise.then((api) => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});
	const changesTree = new PullRequestChangesTreeDataProvider(context);
	context.subscriptions.push(changesTree);
	const reviewManagers = folderManagers.map(folderManager => new ReviewManager(context, folderManager.repository, folderManager, telemetry, changesTree));
	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, git);
	context.subscriptions.push(reviewsManager);
	tree.initialize(reposManager);
	registerCommands(context, reposManager, reviewManagers, telemetry, credentialStore, tree);
	const layout = vscode.workspace.getConfiguration('githubPullRequests').get<string>('fileListLayout');
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat' ? true : false);

	git.onDidChangeState(() => {
		reviewManagers.forEach(reviewManager => reviewManager.updateState());
	});

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderRepositoryManager(repo, telemetry, git, credentialStore);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(context, newFolderManager.repository, newFolderManager, telemetry, changesTree);
			reviewManagers.push(newReviewManager);
			tree.refresh();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);

		const reviewManagerIndex = reviewManagers.findIndex(manager => manager.repository.rootUri.toString() === repo.rootUri.toString());
		if (reviewManagerIndex) {
			const manager = reviewManagers[reviewManagerIndex];
			reviewManagers.splice(reviewManagerIndex);
			manager.dispose();
		}

		tree.refresh();
	});

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);
	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	context.subscriptions.push(new GitLensIntegration());

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	if (path.basename(context.globalStorageUri.fsPath) === 'github.vscode-pull-request-github-insiders') {
		const stable = vscode.extensions.getExtension('github.vscode-pull-request-github');
		if (stable !== undefined) {
			throw new Error('GitHub Pull Requests and Issues Nightly cannot be used while GitHub Pull Requests and Issues is also installed. Please ensure that only one version of the extension is installed.');
		}
	}

	// initialize resources
	Resource.initialize(context);
	const apiImpl = new GitApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new ExperimentationTelemetry(new TelemetryReporter(EXTENSION_ID, version, aiKey));
	context.subscriptions.push(telemetry);

	PersistentState.init(context);
	const credentialStore = new CredentialStore(telemetry);
	context.subscriptions.push(credentialStore);
	await credentialStore.initialize();

	const builtInGitProvider = registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
	}
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	if (apiImpl.repositories.length > 0) {
		await init(context, apiImpl, credentialStore, apiImpl.repositories, prTree, liveshareApiPromise);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, credentialStore, [r], prTree, liveshareApiPromise));
	}

	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
