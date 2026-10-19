/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import { AzureClient } from './client';
import { AzureRemote } from './remote';

const scopes = ['499b84ac-1321-427f-aa17-267ca6975798/.default'];

export class AzureAuthentication {
	constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>) { }

	private key(remote: AzureRemote): string {
		return `azureDevOps.pat:${remote.organizationUrl.toLowerCase()}`;
	}

	async authorization(remote: AzureRemote): Promise<string> {
		if (this.context.globalState.get<boolean>(`${this.key(remote)}:signedOut`, false)) {
			throw new Error(vscode.l10n.t('Sign in to Azure DevOps using the Azure DevOps: Sign In command.'));
		}
		const pat = await this.context.secrets.get(this.key(remote));
		if (pat) {
			return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`;
		}
		if (remote.organizationUrl.startsWith('https://dev.azure.com/')) {
			const session = await vscode.authentication.getSession('microsoft', scopes, { silent: true });
			if (session) {
				return `Bearer ${session.accessToken}`;
			}
		}
		throw new Error(vscode.l10n.t('Sign in to Azure DevOps using the Azure DevOps: Sign In command.'));
	}

	async signIn(remote: AzureRemote): Promise<boolean> {
		const choices = remote.organizationUrl.startsWith('https://dev.azure.com/')
			? [{ label: vscode.l10n.t('Microsoft account') }, { label: vscode.l10n.t('Personal access token') }]
			: [{ label: vscode.l10n.t('Personal access token') }];
		const choice = await vscode.window.showQuickPick(choices, { title: vscode.l10n.t('Sign in to {0}', remote.organizationUrl) });
		if (!choice) {
			return false;
		}
		if (choice.label === vscode.l10n.t('Personal access token')) {
			const pat = await vscode.window.showInputBox({
				title: vscode.l10n.t('Azure DevOps personal access token'),
				prompt: vscode.l10n.t('Requires Code (read & write), Work Items (read & write), and Project and Team (read) permissions. Stored in VS Code Secret Storage.'),
				password: true,
				ignoreFocusOut: true,
				validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a token.'),
			});
			if (!pat) {
				return false;
			}
			const authorization = `Basic ${Buffer.from(`:${pat.trim()}`, 'utf8').toString('base64')}`;
			await new AzureClient(remote, async () => authorization).currentUser();
			await this.context.secrets.store(this.key(remote), pat.trim());
		} else {
			const session = await vscode.authentication.getSession('microsoft', scopes, { createIfNone: true });
			await new AzureClient(remote, async () => `Bearer ${session.accessToken}`).currentUser();
			await this.context.secrets.delete(this.key(remote));
		}
		await this.context.globalState.update(`${this.key(remote)}:signedOut`, false);
		return true;
	}

	async signOut(remote: AzureRemote): Promise<void> {
		await this.context.globalState.update(`${this.key(remote)}:signedOut`, true);
		await this.context.secrets.delete(this.key(remote));
	}
}
