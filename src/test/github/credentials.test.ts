/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, deepStrictEqual } from 'assert';
import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloLink, InMemoryCache } from 'apollo-boost';
import { createSandbox, match, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { GITHUB_ENTERPRISE, URI } from '../../common/settingKeys';
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

function createTestHub(telemetry: MockTelemetry): GitHub {
	const rateLogger = new RateLogger(telemetry, false);
	return {
		octokit: new LoggingOctokit(new Octokit(), rateLogger),
		graphql: new LoggingApolloClient(new ApolloClient({ link: ApolloLink.empty(), cache: new InMemoryCache() }), rateLogger),
	};
}

function stubEnterpriseUri(sinon: SinonSandbox, uri: string): void {
	const getConfiguration = vscode.workspace.getConfiguration;
	const get = sinon.stub();
	get.withArgs(URI).returns(uri);
	const enterpriseConfiguration: vscode.WorkspaceConfiguration = {
		get,
		has: section => section === URI,
		inspect: () => undefined,
		update: async () => { },
	};
	sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section, scope) =>
		section === GITHUB_ENTERPRISE ? enterpriseConfiguration : getConfiguration(section, scope));
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
			let telemetry: MockTelemetry;
			let credentialStore: CredentialStore;
			let hub: GitHub;
			let getHub: SinonStub;
			let getAccountId: SinonStub;
			let getSession: SinonStub;
			let sendTelemetryEvent: SinonStub;
			let session: vscode.AuthenticationSession;

			const forcedSignIns = () => getSession.getCalls().filter(call => call.args[2]?.forceNewSession);

			beforeEach(function () {
				telemetry = new MockTelemetry();
				sendTelemetryEvent = sinon.stub(telemetry, 'sendTelemetryEvent');
				credentialStore = new CredentialStore(telemetry, new MockExtensionContext());
				hub = createTestHub(telemetry);
				getHub = sinon.stub(credentialStore, 'getHub').returns(hub);
				getAccountId = sinon.stub(credentialStore, 'getAccountId').returns('account');
				session = createSession('current-session', 'account', defaultScopes);
				getSession = sinon.stub(vscode.authentication, 'getSession').resolves(session);
				// The user dismisses the forced sign-in, so no new hub is created.
				getSession.withArgs(authProvider, match.any, match.has('forceNewSession')).rejects(new Error('User did not consent to login.'));
				// GitHub Enterprise sign-in is skipped unless a server is configured.
				stubEnterpriseUri(sinon, 'https://github.example.com');
			});

			afterEach(function () {
				credentialStore.dispose();
			});

			it('does not prompt when already signed out', async function () {
				getHub.returns(undefined);

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(getSession.called, false);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('does not prompt for errors from a hub that is no longer in use', async function () {
				getHub.returns(createTestHub(telemetry));

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(getSession.called, false);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('does not prompt after the session is removed but before cached authentication is cleared', async function () {
				getSession.resolves(undefined);

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(sendTelemetryEvent.called, false);
				strictEqual(getSession.called, true);
				for (const call of getSession.getCalls()) {
					strictEqual(call.args[0], authProvider);
					deepStrictEqual(call.args[2], { silent: true });
				}
			});

			it('does not prompt when only another account remains signed in', async function () {
				getSession.resolves(createSession('other-session', 'other-account', defaultScopes));

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(forcedSignIns().length, 0);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('does not prompt if sign-out finishes during the session lookup', async function () {
				getSession.callsFake(async () => {
					getHub.returns(undefined);
					return session;
				});

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(forcedSignIns().length, 0);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('does not prompt if the account is switched during the session lookup', async function () {
				const otherSession = createSession('other-session', 'other-account', defaultScopes);
				getSession.callsFake(async () => {
					getHub.returns(createTestHub(telemetry));
					getAccountId.returns(otherSession.account.id);
					return otherSession;
				});

				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(forcedSignIns().length, 0);
				strictEqual(sendTelemetryEvent.called, false);
			});

			it('prompts once for concurrent errors on the current session and preserves the cooldown', async function () {
				await Promise.all([
					credentialStore.handleAuthError(authProvider, hub),
					credentialStore.handleAuthError(authProvider, hub),
				]);

				const signIns = forcedSignIns();
				strictEqual(signIns.length, 1);
				strictEqual(signIns[0].args[0], authProvider);
				strictEqual(typeof signIns[0].args[2].forceNewSession.detail, 'string');
				strictEqual(sendTelemetryEvent.calledOnceWithExactly('auth.badCredentials'), true);
				deepStrictEqual(await credentialStore.handleAuthError(authProvider, hub), { canceled: true });
				strictEqual(forcedSignIns().length, 1);
			});
		});
	}

	it('retries the current user request after a failure', async function () {
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, new MockExtensionContext());
		const github: GitHub = {
			serverUri: vscode.Uri.parse('https://github.com'),
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
