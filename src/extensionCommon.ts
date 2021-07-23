/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { Repository } from './api/api';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { handler as uriHandler } from './common/uri';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
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
import { GitApiImpl } from './api/api1';

export const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

export let telemetry: TelemetryReporter;

export function setTelemetry(newTelemetry: TelemetryReporter) {
	telemetry = newTelemetry;
}

export async function init(context: vscode.ExtensionContext, git: GitApiImpl, credentialStore: CredentialStore, repositories: Repository[], tree: PullRequestsTreeDataProvider, liveshareApiPromise: Promise<LiveShare | undefined>): Promise<void> {
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

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());

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
	const reviewManagers = folderManagers.map(folderManager => new ReviewManager(folderManager.repository, folderManager, telemetry, changesTree));
	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, git);
	context.subscriptions.push(reviewsManager);
	tree.initialize(reposManager);
	registerCommands(context, reposManager, reviewManagers, telemetry, credentialStore, tree);

	git.onDidChangeState(() => {
		reviewManagers.forEach(reviewManager => reviewManager.updateState());
	});

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderRepositoryManager(repo, telemetry, git, credentialStore);
			reposManager.folderManagers.push(newFolderManager);
			const newReviewManager = new ReviewManager(newFolderManager.repository, newFolderManager, telemetry, changesTree);
			reviewManagers.push(newReviewManager);
			tree.refresh();
			disposable.dispose();
		});
	});

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);
	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function commonDeactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}