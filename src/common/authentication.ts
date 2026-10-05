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
	constructor(message: string = vscode.l10n.t('Not authenticated')) {
		super(message);
	}
}

export function getSessionGitHubUri(authProviderId: AuthProvider, session: Pick<vscode.AuthenticationSession, 'authorizationServer'> | undefined): vscode.Uri {
	if (authProviderId === AuthProvider.github) {
		return vscode.Uri.parse('https://github.com');
	}

	const issuer = session?.authorizationServer;
	const oauthSuffix = '/login/oauth';
	const path = issuer?.path.replace(/\/$/, '');
	const unavailable = () => new AuthenticationError(vscode.l10n.t('GitHub Enterprise is unavailable because the authentication session does not include a supported authorization server. Use a VS Code build with authIssuers session support and sign in again.'));
	if (!issuer || (issuer.scheme !== 'https' && issuer.scheme !== 'http') || !issuer.authority
		|| /[@\s]/.test(issuer.authority) || issuer.query || issuer.fragment || !path?.endsWith(oauthSuffix)) {
		throw unavailable();
	}
	try {
		new URL(issuer.toString());
	} catch (error) {
		if (error instanceof TypeError) {
			throw unavailable();
		}
		throw error;
	}

	return issuer.with({ path: path.slice(0, -oauthSuffix.length) });
}

export function isSamlError(e: { message?: string }): boolean {
	return !!e.message?.includes('Resource protected by organization SAML enforcement.');
}
