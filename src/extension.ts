/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { Repository } from './api/api';
import { ApiImpl } from './api/api1';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { onceEvent } from './common/utils';
import * as PersistentState from './common/persistentState';
import { EXTENSION_ID } from './constants';
import { FolderPullRequestManager } from './github/folderPullRequestManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { CredentialStore } from './github/credentials';
import { GitExtension, GitAPI } from './typings/git';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { LiveShare } from 'vsls/vscode.js';
import { PullRequestManager } from './github/pullRequestManager';

const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(context: vscode.ExtensionContext, git: ApiImpl, gitAPI: GitAPI, credentialStore: CredentialStore, repositories: Repository[], tree: PullRequestsTreeDataProvider, liveshareApiPromise: Promise<LiveShare | undefined>): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	vscode.authentication.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await prManager.clearCredentialCache();
			if (reviewManagers) {
				reviewManagers.forEach(reviewManager => reviewManager.updateState());
			}
		}
	});

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());

	const folderManagers = repositories.map(repository => new FolderPullRequestManager(repository, telemetry, git, credentialStore));
	context.subscriptions.push(...folderManagers);
	const prManager = new PullRequestManager(folderManagers, credentialStore);
	context.subscriptions.push(prManager);

	liveshareApiPromise.then((api) => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(prManager));
		}
	});
	const reviewManagers = folderManagers.map(folderManager => new ReviewManager(context, folderManager.repository, folderManager, prManager, tree, telemetry));
	await tree.initialize(prManager);
	registerCommands(context, prManager, reviewManagers, telemetry, credentialStore, tree);

	git.onDidChangeState(() => {
		reviewManagers.forEach(reviewManager => reviewManager.updateState());
	});

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderPullRequestManager(repo, telemetry, git, credentialStore);
			prManager.folderManagers.push(newFolderManager);
			const newReviewManager = new ReviewManager(context, newFolderManager.repository, newFolderManager, prManager, tree, telemetry);
			reviewManagers.push(newReviewManager);
			tree.refresh();
			disposable.dispose();
		});
	});

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);
	// TODO: update issues features
	const issuesFeatures = new IssueFeatureRegistrar(gitAPI, folderManagers[0], reviewManagers, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<ApiImpl> {
	// initialize resources
	Resource.initialize(context);
	const apiImpl = new ApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, aiKey);
	context.subscriptions.push(telemetry);

	PersistentState.init(context);
	const credentialStore = new CredentialStore(telemetry);
	await credentialStore.initialize();

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;
	const gitAPI = gitExtension.getAPI(1);

	context.subscriptions.push(registerBuiltinGitProvider(apiImpl));
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	if (apiImpl.repositories.length > 0) {
		await init(context, apiImpl, gitAPI, credentialStore, apiImpl.repositories, prTree, liveshareApiPromise);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, gitAPI, credentialStore, [r], prTree, liveshareApiPromise));
	}

	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}