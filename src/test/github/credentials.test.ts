/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, deepStrictEqual } from 'assert';
import { Octokit } from '@octokit/rest';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { CredentialStore, findExistingSession, GitHub, hasAccountChanged } from '../../github/credentials';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { commands } from '../../common/executeCommands';
import { EXTENSION_ID } from '../../constants';

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

	describe('account preferences for inaccessible repositories', function () {
		let credentialStore: CredentialStore;

		beforeEach(function () {
			credentialStore = new CredentialStore(new MockTelemetry(), new MockExtensionContext());
		});

		afterEach(function () {
			credentialStore.dispose();
		});

		it('offers a modal and opens preferences for the affected provider', async function () {
			const getAccounts = sinon.stub(vscode.authentication, 'getAccounts').resolves([
				{ id: 'personal', label: 'Personal' },
				{ id: 'work', label: 'Work' },
			]);
			const manageAccounts = { title: vscode.l10n.t('Manage Account Preferences') };
			const warning = sinon.stub(vscode.window, 'showWarningMessage').callsFake(async (_message, _options, ...items: vscode.MessageItem[]) => items[0]);
			const execute = sinon.stub(commands, 'executeCommand').resolves();

			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');

			deepStrictEqual(getAccounts.firstCall.args, [AuthProvider.github]);
			strictEqual(warning.firstCall.args[0].includes('owner/repo'), true);
			deepStrictEqual(warning.firstCall.args.slice(1), [{ modal: true }, manageAccounts]);
			deepStrictEqual(execute.firstCall.args, [commands.MANAGE_EXTENSION_ACCOUNT_PREFERENCES, EXTENSION_ID, AuthProvider.github]);
		});

		it('does not open preferences on dismissal and suppresses concurrent and repeated prompts', async function () {
			sinon.stub(vscode.authentication, 'getAccounts').resolves([
				{ id: 'personal', label: 'Personal' },
				{ id: 'work', label: 'Work' },
			]);
			const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const execute = sinon.stub(commands, 'executeCommand').resolves();

			await Promise.all([
				credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo'),
				credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/other'),
			]);
			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');
			strictEqual(warning.callCount, 1);
			strictEqual(execute.called, false);

			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.githubEnterprise, 'owner/repo');
			strictEqual(warning.callCount, 2);
		});

		it('does not prompt without multiple accounts, but can prompt after another account is added', async function () {
			const getAccounts = sinon.stub(vscode.authentication, 'getAccounts').resolves([]);
			const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);

			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');
			getAccounts.resolves([{ id: 'personal', label: 'Personal' }]);
			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');
			strictEqual(warning.called, false);

			getAccounts.resolves([{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }]);
			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');
			strictEqual(warning.callCount, 1);
		});

		it('does not propagate account lookup or command failures', async function () {
			const getAccounts = sinon.stub(vscode.authentication, 'getAccounts').rejects(new Error('Provider unavailable'));
			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');

			getAccounts.resolves([{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }]);
			sinon.stub(vscode.window, 'showWarningMessage').callsFake(async (_message, _options, ...items: vscode.MessageItem[]) => items[0]);
			const execute = sinon.stub(commands, 'executeCommand').rejects(new Error('Command unavailable'));
			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');
			strictEqual(execute.calledOnce, true);
		});

		it('does not show a dialog if disposed during account lookup', async function () {
			sinon.stub(vscode.authentication, 'getAccounts').callsFake(async () => {
				credentialStore.dispose();
				return [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }];
			});
			const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);

			await credentialStore.showAccountPreferencesForInaccessibleRepository(AuthProvider.github, 'owner/repo');

			strictEqual(warning.called, false);
		});
	});

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
