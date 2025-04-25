/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export enum GitHubServerType {
	None,
	GitHubDotCom,
	Enterprise
}

export enum AuthProvider {
	github = 'github',
	githubEnterprise = 'github-enterprise'
}

export class AuthenticationError extends Error {
	constructor() {
		super(vscode.l10n.t('Not authenticated'));
	}
}

export function isSamlError(e: { message?: string }): boolean {
	return !!e.message?.includes('Resource protected by organization SAML enforcement.');
}
