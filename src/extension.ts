/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { migrateConfiguration } from './authentication/vsConfiguration';
import { Resource } from './common/resources';
import { ReviewManager } from './view/reviewManager';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { PullRequestManager } from './github/pullRequestManager';
import { formatError, onceEvent } from './common/utils';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { handler as uriHandler } from './common/uri';
import * as Keychain from './authentication/keychain';
import * as Storage  from './common/storage';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ApiImpl } from './api/api1';
import { Repository } from './api/api';
import TelemetryReporter from 'vscode-extension-telemetry';
import { EXTENSION_ID } from './constants';

const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(context: vscode.ExtensionContext, git: ApiImpl, repository: Repository, tree: PullRequestsTreeDataProvider): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	Keychain.init(context);
	Storage.init(context);
	await migrateConfiguration();
	context.subscriptions.push(Keychain.onDidChange(async _ => {
		if (prManager) {
			try {
				await prManager.clearCredentialCache();
				if (reviewManager) {
					reviewManager.updateState();
				}
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));
			}
		}
	}));

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());

	const prManager = new PullRequestManager(repository, telemetry);
	context.subscriptions.push(prManager);

	const reviewManager = new ReviewManager(context, repository, prManager, tree, telemetry);
	tree.initialize(prManager);
	registerCommands(context, prManager, reviewManager, telemetry);

	git.repositories.forEach(repo => {
		repo.ui.onDidChange(() => {
			// No multi-select support, always show last selected repo
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
				tree.updateQueries();
			}
		});
	});

	git.onDidOpenRepository(repo => {
		repo.ui.onDidChange(() => {
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
				tree.updateQueries();
			}
		});
	});

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

	context.subscriptions.push(registerBuiltinGitProvider(apiImpl));
	context.subscriptions.push(registerLiveShareGitProvider(apiImpl));
	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	const firstRepository = apiImpl.repositories[0];
	if (firstRepository) {
		await init(context, apiImpl, firstRepository, prTree);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, r, prTree));
	}

	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}