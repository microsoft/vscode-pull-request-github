/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	name: string;
	stack?: string;
	constructor(public message: string) {
		super(message);
	}
}

export function isSamlError(e: { message?: string }): boolean {
	return !!e.message?.startsWith('Resource protected by organization SAML enforcement.');
}
