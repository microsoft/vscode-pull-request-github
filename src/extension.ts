/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { Repository } from './common/repository';
import { VSCodeConfiguration } from './authentication/vsConfiguration';
import { Resource } from './common/resources';
import { ReviewManager } from './view/reviewManager';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { PullRequestManager } from './github/pullRequestManager';
import { setGitPath } from './common/git';
import { formatError } from './common/utils';
import { GitExtension } from './typings/git';

export async function activate(context: vscode.ExtensionContext) {
	// initialize resources
	Resource.initialize(context);

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git').exports;
	const api = gitExtension.getAPI(1);
	setGitPath(api.git.path);

	Logger.appendLine('Looking for git repository');

	const rootPath = vscode.workspace.rootPath;
	const repository = new Repository(rootPath);
	let repositoryInitialized = false;
	let prManager: PullRequestManager;

	repository.onDidRunGitStatus(async e => {
		if (repositoryInitialized) {
			return;
		}

		Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

		const configuration = new VSCodeConfiguration();
		configuration.onDidChange(async _ => {
			if (prManager) {
				try {
					await prManager.clearCredentialCache();
					if (repository) {
						repository.status();
					}
				} catch (e) {
					vscode.window.showErrorMessage(formatError(e));
				}
			}
		});
		context.subscriptions.push(configuration.listenForVSCodeChanges());

		repositoryInitialized = true;
		prManager = new PullRequestManager(configuration, repository);
		const reviewManager = new ReviewManager(context, configuration, repository, prManager);
		registerCommands(context, prManager, reviewManager);
	});
}
