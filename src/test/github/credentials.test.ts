/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, deepStrictEqual } from 'assert';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { findExistingSession } from '../../github/credentials';

const oldestScopes = ['read:user', 'user:email', 'repo'];
const defaultScopes = [...oldestScopes, 'workflow'];
const additionalScopes = [...defaultScopes, 'project', 'read:org'];

function scopesEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((scope, index) => scope === expected[index]);
}

function createSession(id: string, accountId: string, scopes: string[]): vscode.AuthenticationSession {
	return {
		id,
		accessToken: `${id}-token`,
		account: {
			id: accountId,
			label: accountId,
		},
		scopes,
	};
}

describe('CredentialStore', function () {
	describe('findExistingSession', function () {
		it('keeps broader scope lookup on the preferred account', async function () {
			const firstAccountAdditional = createSession('first-additional', 'first', additionalScopes);
			const secondAccountDefault = createSession('second-default', 'second', defaultScopes);
			const requests: { scopes: readonly string[], accountId?: string }[] = [];

			const result = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				requests.push({ scopes, accountId: options.account?.id });
				if (options.account?.id === 'second') {
					return undefined;
				}
				if (scopesEqual(scopes, defaultScopes)) {
					return secondAccountDefault;
				}
				if (scopesEqual(scopes, additionalScopes)) {
					return firstAccountAdditional;
				}
				return undefined;
			});

			strictEqual(result?.session, secondAccountDefault);
			deepStrictEqual(result?.scopes, defaultScopes);
			deepStrictEqual(requests, [
				{ scopes: defaultScopes, accountId: undefined },
				{ scopes: additionalScopes, accountId: 'second' },
			]);
		});

		it('uses broader scopes when they belong to the preferred account', async function () {
			const preferredDefault = createSession('preferred-default', 'preferred', defaultScopes);
			const preferredAdditional = createSession('preferred-additional', 'preferred', additionalScopes);

			const result = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				if (options.account?.id === 'preferred' && scopesEqual(scopes, additionalScopes)) {
					return preferredAdditional;
				}
				if (!options.account && scopesEqual(scopes, defaultScopes)) {
					return preferredDefault;
				}
				return undefined;
			});

			strictEqual(result?.session, preferredAdditional);
			deepStrictEqual(result?.scopes, additionalScopes);
		});

		it('falls back to legacy and additional-only sessions', async function () {
			const legacySession = createSession('legacy', 'legacy', oldestScopes);
			const legacyResult = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				if (!options.account && scopesEqual(scopes, oldestScopes)) {
					return legacySession;
				}
				return undefined;
			});

			strictEqual(legacyResult?.session, legacySession);
			deepStrictEqual(legacyResult?.scopes, oldestScopes);

			const additionalSession = createSession('additional', 'additional', additionalScopes);
			const additionalResult = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				if (!options.account && scopesEqual(scopes, additionalScopes)) {
					return additionalSession;
				}
				return undefined;
			});

			strictEqual(additionalResult?.session, additionalSession);
			deepStrictEqual(additionalResult?.scopes, additionalScopes);
		});
	});
});
