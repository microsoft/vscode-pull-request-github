/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzureAuthentication, AzureSignInRequired } from './authentication';
import { AzureApiError, AzureClient } from './client';
import { trustedServerCollections } from './configuration';
import { AzurePullRequestProvider } from './pullRequestProvider';
import { AzureRemote, azureRepositoryUrl, parseAzureRemote } from './remote';
import { PendingReviews, ViewedFiles } from './review';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { IAccount } from '../github/interface';

export class AzureSessions extends Disposable {
	private readonly authentication: AzureAuthentication;
	private readonly reviews: PendingReviews;
	private readonly viewed: ViewedFiles;
	private readonly providers = new Map<string, AzurePullRequestProvider>();
	private readonly remotes = new Map<string, AzureRemote>();
	private readonly accounts = new Map<string, IAccount>();
	private readonly requests = new Map<string, Promise<boolean>>();
	private version = 0;
	private readonly changed = this._register(new vscode.EventEmitter<void>());
	readonly onDidChange = this.changed.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly createClient: (remote: AzureRemote, authorization: () => Promise<string>) => AzureClient =
			(remote, authorization) => new AzureClient(remote, authorization),
	) {
		super();
		this.authentication = new AzureAuthentication(context);
		this.reviews = new PendingReviews(context.globalState);
		this.viewed = new ViewedFiles(context.globalState);
		this._register(vscode.authentication.onDidChangeSessions(event => {
			if (event.provider.id === 'microsoft') {
				this.invalidate();
			}
		}));
		this._register(context.secrets.onDidChange(event => {
			if (event.key.startsWith('azureDevOps.pat:')) {
				this.invalidate();
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('azureDevOpsPullRequests.serverCollections') || event.affectsConfiguration('azureDevOps.serverCollections')) {
				this.providers.clear();
				this.remotes.clear();
				this.invalidate();
			}
		}));
	}

	private identity(remote: Remote): AzureRemote {
		const url = remote.gitProtocol.azureRemote ? azureRepositoryUrl(remote.gitProtocol.azureRemote) : remote.url;
		const azure = parseAzureRemote(url, trustedServerCollections());
		if (!azure) {
			throw new Error(vscode.l10n.t('This remote is not an Azure DevOps repository in a trusted organization or collection.'));
		}
		return azure;
	}

	provider(remote: Remote): AzurePullRequestProvider {
		const azure = this.identity(remote);
		const key = azureRepositoryUrl(azure).toLowerCase();
		let provider = this.providers.get(key);
		if (!provider) {
			provider = new AzurePullRequestProvider(this.createClient(azure, () => {
				this.identity(remote);
				return this.authentication.authorization(azure);
			}), this.reviews, this.viewed);
			this.providers.set(key, provider);
		}
		this.remotes.set(key, azure);
		return provider;
	}

	isAuthenticated(remote?: Remote): boolean {
		if (!remote) {
			return this.accounts.size > 0;
		}
		const azure = parseAzureRemote(remote.gitProtocol.normalizeUri()?.toString() ?? remote.url, trustedServerCollections());
		return !!azure && this.accounts.has(azure.organizationUrl.toLowerCase());
	}

	async refresh(remote: Remote): Promise<boolean> {
		const provider = this.provider(remote);
		const key = this.identity(remote).organizationUrl.toLowerCase();
		const pending = this.requests.get(key);
		if (pending) {
			return pending;
		}
		const version = this.version;
		const request = (async () => {
			try {
				const account = await provider.currentUser();
				if (this.version !== version) {
					throw new Error(vscode.l10n.t('The Azure DevOps session changed while signing in. Refresh to retry.'));
				}
				this.accounts.set(key, account);
				return true;
			} catch (error) {
				if (error instanceof AzureSignInRequired || error instanceof AzureApiError && error.status === 401) {
					const removed = this.accounts.delete(key);
					if (error instanceof AzureApiError) {
						Logger.warn(error.message, 'AzureAuthentication');
					}
					if (removed) {
						this.changed.fire();
					}
					return false;
				}
				throw error;
			}
		})().finally(() => {
			if (this.requests.get(key) === request) {
				this.requests.delete(key);
			}
		});
		this.requests.set(key, request);
		return request;
	}

	private invalidate(): void {
		this.version++;
		this.accounts.clear();
		this.requests.clear();
		this.changed.fire();
	}

	private async selectRemote(): Promise<AzureRemote | undefined> {
		const organizations = new Map([...this.remotes.values()].map(remote => [remote.organizationUrl.toLowerCase(), remote]));
		if (organizations.size === 0) {
			await vscode.window.showWarningMessage(vscode.l10n.t('Open a folder with an Azure DevOps Git remote before signing in.'));
			return;
		}
		if (organizations.size === 1) {
			return organizations.values().next().value;
		}
		return (await vscode.window.showQuickPick([...organizations.values()].map(remote => ({
			label: remote.organizationUrl, remote,
		})), { title: vscode.l10n.t('Select an Azure DevOps organization or collection') }))?.remote;
	}

	async signIn(): Promise<boolean> {
		const remote = await this.selectRemote();
		if (!remote || !await this.authentication.signIn(remote)) {
			return false;
		}
		this.invalidate();
		return true;
	}

	async signOut(): Promise<void> {
		const remote = await this.selectRemote();
		if (remote) {
			await this.authentication.signOut(remote);
			this.invalidate();
		}
	}

	override dispose(): void {
		this.version++;
		this.requests.clear();
		this.accounts.clear();
		this.providers.clear();
		super.dispose();
	}
}
