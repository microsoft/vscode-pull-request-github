/* eslint-disable @typescript-eslint/no-var-requires */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { LiveShare } from 'vsls/vscode.js';
import { Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { CredentialStore } from './azdo/credentials';
import { FileReviewedStatusService } from './azdo/fileReviewedStatusService';
import { FolderRepositoryManager } from './azdo/folderRepositoryManager';
import { RepositoriesManager } from './azdo/repositoriesManager';
import { AzdoUserManager } from './azdo/userManager';
import { AzdoWorkItem } from './azdo/workItem';
import { registerCommands } from './commands';
import { LocalStorageService } from './common/localStorageService';
import Logger from './common/logger';
import * as PersistentState from './common/persistentState';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { onceEvent } from './common/utils';
import { EXTENSION_ID, SETTINGS_NAMESPACE } from './constants';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { MockGitProvider } from './gitProviders/mockGitProvider';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { ReviewsManager } from './view/reviewsManager';

const aiKey: string = '6d22c8ed-52c8-4779-a6f8-09c748e18e95';

// fetch.promise polyfill
const PolyfillPromise = require('es6-promise').Promise;
const fetch = require('node-fetch');

fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(
	context: vscode.ExtensionContext,
	git: GitApiImpl,
	credentialStore: CredentialStore,
	repositories: Repository[],
	tree: PullRequestsTreeDataProvider,
	liveshareApiPromise: Promise<LiveShare | undefined>,
): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	// vscode.authentication.onDidChangeSessions(async e => {
	// 	if (e.provider.id === 'github') {
	// 		await reposManager.clearCredentialCache();
	// 		if (reviewManagers) {
	// 			reviewManagers.forEach(reviewManager => reviewManager.updateState());
	// 		}
	// 	}
	// });

	const localStorageService = new LocalStorageService(context.workspaceState);
	const fileReviewedStatusService = new FileReviewedStatusService(localStorageService);

	vscode.authentication.onDidChangeSessions(async (e) => {
		if (e.provider.id === 'microsoft') {
			await reposManager.clearCredentialCache();
			if (reviewManagers) {
				reviewManagers.forEach(reviewManager => reviewManager.updateState());
			}
		}
	});

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

	const workItem = new AzdoWorkItem(credentialStore, telemetry);
	await workItem.ensure();
	context.subscriptions.push(workItem);

	const userManager = new AzdoUserManager(credentialStore, telemetry);
	await userManager.ensure();
	context.subscriptions.push(userManager);
	const folderManagers = repositories.map(
		repository => new FolderRepositoryManager(repository, telemetry, git, credentialStore, fileReviewedStatusService),
	);
	context.subscriptions.push(...folderManagers);
	const reposManager = new RepositoriesManager(folderManagers, credentialStore, telemetry);
	context.subscriptions.push(reposManager);

	liveshareApiPromise.then(api => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			// TODO used by VLSS.
			// api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});
	const changesTree = new PullRequestChangesTreeDataProvider(context);
	context.subscriptions.push(changesTree);
	const reviewManagers = folderManagers.map(
		folderManager => new ReviewManager(context, folderManager.repository, folderManager, telemetry, changesTree),
	);
	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, git);
	context.subscriptions.push(reviewsManager);
	tree.initialize(reposManager);
	registerCommands(context, reposManager, reviewManagers, workItem, userManager, telemetry, credentialStore, tree);
	const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');

	git.onDidChangeState(() => {
		reviewManagers.forEach(reviewManager => reviewManager.updateState());
	});

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderRepositoryManager(
				repo,
				telemetry,
				git,
				credentialStore,
				fileReviewedStatusService,
			);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(
				context,
				newFolderManager.repository,
				newFolderManager,
				telemetry,
				changesTree,
			);
			reviewManagers.push(newReviewManager);
			tree.refresh();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);

		const reviewManagerIndex = reviewManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (reviewManagerIndex) {
			const manager = reviewManagers[reviewManagerIndex];
			reviewManagers.splice(reviewManagerIndex);
			manager.dispose();
		}

		tree.refresh();
	});

	await vscode.commands.executeCommand('setContext', 'azdo:initialized', true);
	// TODO Investigate what is intialized in issues
	// const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	// context.subscriptions.push(issuesFeatures);
	// await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	// initialize resources
	Resource.initialize(context);
	const apiImpl = new GitApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, aiKey);
	context.subscriptions.push(telemetry);

	// const session = await registerGithubExtension();

	PersistentState.init(context);
	const credentialStore = new CredentialStore(telemetry, context.secrets);
	context.subscriptions.push(credentialStore);
	await credentialStore.initialize();

	const builtInGitProvider = await registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
	} else {
		const mockGitProvider = new MockGitProvider();
		context.subscriptions.push(apiImpl.registerGitProvider(mockGitProvider));
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

const SCOPES = ['vso.identity', 'vso.code'];
async function registerGithubExtension() {
	const session = await vscode.authentication.getSession('azdo', SCOPES, { createIfNone: false });
	return session;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
