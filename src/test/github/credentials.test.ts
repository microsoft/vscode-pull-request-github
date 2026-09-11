/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, deepStrictEqual } from 'assert';
import { Octokit } from '@octokit/rest';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { CredentialStore, findExistingSession, GitHub, hasAccountChanged } from '../../github/credentials';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

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
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('findExistingSession', function () {
		it('keeps broader scope lookup on the preferred account', async function () {
			const firstAccountAdditional = createSession('first-additional', 'first', additionalScopes);
			const secondAccountDefault = createSession('second-default', 'second', defaultScopes);
			const requests: { scopes: readonly string[], accountId?: string }[] = [];

			const result = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				requests.push({ scopes, accountId: options.account?.id });
				if (!scopes.length) {
					return secondAccountDefault;
				}
				if (options.account?.id === 'second' && scopesEqual(scopes, defaultScopes)) {
					return secondAccountDefault;
				}
				if (scopesEqual(scopes, defaultScopes)) {
					return secondAccountDefault;
				}
				if (!options.account && scopesEqual(scopes, additionalScopes)) {
					return firstAccountAdditional;
				}
				return undefined;
			});

			strictEqual(result?.session, secondAccountDefault);
			deepStrictEqual(result?.scopes, defaultScopes);
			deepStrictEqual(requests, [
				{ scopes: [], accountId: undefined },
				{ scopes: additionalScopes, accountId: 'second' },
				{ scopes: defaultScopes, accountId: 'second' },
			]);
		});

		it('uses the preferred account when accounts have different scope sets', async function () {
			const firstAccountDefault = createSession('first-default', 'first', defaultScopes);
			const secondAccountAdditional = createSession('second-additional', 'second', additionalScopes);
			const requests: { scopes: readonly string[], accountId?: string }[] = [];

			const result = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				requests.push({ scopes, accountId: options.account?.id });
				if (!scopes.length) {
					return secondAccountAdditional;
				}
				if (!options.account && scopesEqual(scopes, defaultScopes)) {
					return firstAccountDefault;
				}
				if (options.account?.id === 'second' && scopesEqual(scopes, additionalScopes)) {
					return secondAccountAdditional;
				}
				return undefined;
			});

			strictEqual(result?.session, secondAccountAdditional);
			deepStrictEqual(result?.scopes, additionalScopes);
			deepStrictEqual(requests, [
				{ scopes: [], accountId: undefined },
				{ scopes: additionalScopes, accountId: 'second' },
			]);
		});

		it('uses broader scopes when they belong to the preferred account', async function () {
			const preferredDefault = createSession('preferred-default', 'preferred', defaultScopes);
			const preferredAdditional = createSession('preferred-additional', 'preferred', additionalScopes);

			const result = await findExistingSession(AuthProvider.github, async (_providerId, scopes, options) => {
				if (!scopes.length) {
					return preferredDefault;
				}
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
				if (!scopes.length || (options.account?.id === 'additional' && scopesEqual(scopes, additionalScopes))) {
					return additionalSession;
				}
				return undefined;
			});

			strictEqual(additionalResult?.session, additionalSession);
			deepStrictEqual(additionalResult?.scopes, additionalScopes);
		});
	});

	describe('hasAccountChanged', function () {
		it('does not treat a new session for the same account as an account change', function () {
			const session = createSession('new-session', 'account', additionalScopes);

			strictEqual(hasAccountChanged('account', session), false);
		});

		it('detects account changes and sign out', function () {
			const session = createSession('new-session', 'new-account', defaultScopes);

			strictEqual(hasAccountChanged('old-account', session), true);
			strictEqual(hasAccountChanged('old-account', undefined), true);
		});
	});

	for (const authProvider of [AuthProvider.github, AuthProvider.githubEnterprise]) {
		describe(`handleAuthError (${authProvider})`, function () {
			let credentialStore: CredentialStore;
			let isAuthenticated: SinonStub;
			let getSession: SinonStub;
			let initialize: SinonStub;
			let sendTelemetryEvent: SinonStub;
			let session: vscode.AuthenticationSession;

			beforeEach(function () {
				const telemetry = new MockTelemetry();
				sendTelemetryEvent = sinon.stub(telemetry, 'sendTelemetryEvent');
				credentialStore = new CredentialStore(telemetry, new MockExtensionContext());
				isAuthenticated = sinon.stub(credentialStore, 'isAuthenticated').returns(true);
				initialize = sinon.stub(credentialStore as any, 'initialize');
				initialize.resolves({ canceled: false });
				session = createSession('current-session', 'account', defaultScopes);
				getSession = sinon.stub(vscode.authentication, 'getSession').resolves(session);
			});

			afterEach(function () {
				credentialStore.dispose();
			});

			it('does not prompt when already signed out', async function () {
				isAuthenticated.returns(false);

				deepStrictEqual(await credentialStore.handleAuthError(authProvider), { canceled: true });
				strictEqual(getSession.called, false);
				strictEqual(initialize.called, false);
			});

			it('does not prompt after the session is removed but before cached authentication is cleared', async function () {
				getSession.resolves(undefined);

				deepStrictEqual(await credentialStore.handleAuthError(authProvider), { canceled: true });
				strictEqual(initialize.called, false);
				strictEqual(sendTelemetryEvent.called, false);
				strictEqual(getSession.called, true);
				for (const call of getSession.getCalls()) {
					strictEqual(call.args[0], authProvider);
					deepStrictEqual(call.args[2], { silent: true });
				}
			});

			it('does not prompt if sign-out finishes during the session lookup', async function () {
				getSession.callsFake(async () => {
					isAuthenticated.returns(false);
					return session;
				});

				deepStrictEqual(await credentialStore.handleAuthError(authProvider), { canceled: true });
				strictEqual(initialize.called, false);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('deduplicates re-authentication for an existing invalid session and preserves the cooldown', async function () {
				const results = await Promise.all([
					credentialStore.handleAuthError(authProvider),
					credentialStore.handleAuthError(authProvider),
				]);

				deepStrictEqual(results, [{ canceled: false }, { canceled: false }]);
				strictEqual(initialize.calledOnce, true);
				strictEqual(initialize.firstCall.args[0], authProvider);
				strictEqual(typeof initialize.firstCall.args[1].forceNewSession.detail, 'string');
				strictEqual(sendTelemetryEvent.calledOnceWithExactly('auth.badCredentials'), true);
				deepStrictEqual(await credentialStore.handleAuthError(authProvider), { canceled: true });
				strictEqual(initialize.calledOnce, true);
			});
		});
	}

	it('retries the current user request after a failure', async function () {
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, new MockExtensionContext());
		const github: GitHub = {
			octokit: new LoggingOctokit(new Octokit(), new RateLogger(telemetry, false)),
			graphql: {} as LoggingApolloClient,
		};
		sinon.stub(credentialStore, 'getHub').returns(github);
		const getAuthenticatedUser = sinon.stub(github.octokit, 'call');
		const error = new Error('Connect Timeout Error');
		getAuthenticatedUser.onFirstCall().rejects(error);
		getAuthenticatedUser.onSecondCall().resolves({
			data: {
				login: 'octocat',
				node_id: 'MDQ6VXNlcjE=',
				html_url: 'https://github.com/octocat',
				avatar_url: 'https://github.com/images/error/octocat_happy.gif',
				type: 'User',
				plan: { name: 'emu_user' },
			}
		});

		deepStrictEqual(await Promise.allSettled([
			credentialStore.getCurrentUser(AuthProvider.github),
			credentialStore.getIsEmu(AuthProvider.github),
		]), [
			{ status: 'rejected', reason: error },
			{ status: 'rejected', reason: error },
		]);
		strictEqual(getAuthenticatedUser.callCount, 1);
		strictEqual(github.currentUser, undefined);
		strictEqual(github.isEmu, undefined);
		const [currentUser, isEmu] = await Promise.all([
			credentialStore.getCurrentUser(AuthProvider.github),
			credentialStore.getIsEmu(AuthProvider.github),
		]);
		const cachedCurrentUser = await credentialStore.getCurrentUser(AuthProvider.github);

		deepStrictEqual({
			requests: getAuthenticatedUser.callCount,
			login: currentUser.login,
			isEmu,
			cachedLogin: cachedCurrentUser.login,
		}, {
			requests: 2,
			login: 'octocat',
			isEmu: true,
			cachedLogin: 'octocat',
		});
	});
});
