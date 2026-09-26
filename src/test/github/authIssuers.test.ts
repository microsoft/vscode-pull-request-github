/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { gql } from 'apollo-boost';
import { Response } from 'cross-fetch';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitHubManager } from '../../authentication/githubServer';
import { AuthProvider, GitHubServerType } from '../../common/authentication';
import { GitHubRemote, parseRemote } from '../../common/remote';
import { GithubRemoteSourceProvider } from '../../gitExtensionIntegration';
import { CredentialStore, CredentialStoreSessionsChangeEvent, GitHub } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { LoggingOctokit } from '../../github/loggingOctokit';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

const scopes = ['read:user', 'user:email', 'repo', 'workflow'];
const additionalScopes = [...scopes, 'project', 'read:org'];
const hostA = 'https://host-a.example';
const hostB = 'https://host-b.example';
const httpLink: typeof import('apollo-link-http') = require('apollo-link-http');
const viewerQuery = gql`query { viewer { login } }`;

function session(issuer?: string, overrides: Partial<vscode.AuthenticationSession> = {}): vscode.AuthenticationSession {
	return {
		id: 'session',
		account: { id: 'account', label: 'account' },
		accessToken: 'test-token',
		scopes,
		authorizationServer: issuer ? vscode.Uri.parse(issuer) : undefined,
		...overrides,
	};
}

describe('authIssuers', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let store: CredentialStore;
	let selected: Map<string, vscode.AuthenticationSession>;
	let getSession: SinonStub;
	let apiCall: SinonStub;
	let graphqlFetch: SinonStub;
	let configuration: SinonStub;
	let showError: SinonStub;
	let changes: CredentialStoreSessionsChangeEvent[];
	let sessionEvents: vscode.EventEmitter<vscode.AuthenticationSessionsChangeEvent>;

	function enterpriseHub(): GitHub {
		const hub = store.getHub(AuthProvider.githubEnterprise);
		assert.ok(hub);
		return hub;
	}

	async function refreshSession(value?: vscode.AuthenticationSession): Promise<void> {
		if (value) {
			selected.set(AuthProvider.githubEnterprise, value);
		} else {
			selected.delete(AuthProvider.githubEnterprise);
		}
		sessionEvents.fire({ provider: { id: AuthProvider.githubEnterprise, label: 'GitHub Enterprise' } });
		await new Promise<void>(resolve => setImmediate(resolve));
	}

	beforeEach(function () {
		sinon = createSandbox();
		selected = new Map();
		changes = [];
		sinon.stub(process, 'env').value({ ...process.env, GITHUB_OAUTH_TOKEN: undefined, GITHUB_TEST_SERVER: undefined });
		const settings: vscode.WorkspaceConfiguration = {
			get: sinon.stub().callsFake((key: string, defaultValue?: unknown) => key === 'uri' ? hostA : defaultValue),
			has: sinon.stub().returns(true),
			inspect: sinon.stub().returns(undefined),
			update: sinon.stub().rejects(new Error('Tests must not write settings')),
		};
		configuration = sinon.stub(vscode.workspace, 'getConfiguration').returns(settings);
		getSession = sinon.stub(vscode.authentication, 'getSession').callsFake(async (provider, requestedScopes, options = {}) => {
			assert.ok(Array.isArray(requestedScopes), 'Expected a GitHub scopes request');
			const candidate = selected.get(provider);
			if (!candidate || !requestedScopes.every(scope => candidate.scopes.includes(scope))
				|| (options.account && options.account.id !== candidate.account.id)
				|| (options.authorizationServer && options.authorizationServer.toString() !== candidate.authorizationServer?.toString())) {
				return undefined;
			}
			return candidate;
		});
		sessionEvents = new vscode.EventEmitter<vscode.AuthenticationSessionsChangeEvent>();
		sinon.stub(vscode.authentication, 'onDidChangeSessions').value(sessionEvents.event);
		showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
		apiCall = sinon.stub(LoggingOctokit.prototype, 'call').resolves({
			data: { login: 'octocat', node_id: 'user', html_url: `${hostB}/octocat`, avatar_url: '', type: 'User' },
		});
		graphqlFetch = sinon.stub().callsFake(async () => new Response(JSON.stringify({ data: { viewer: { login: 'octocat' } } }), {
			status: 200, headers: { 'content-type': 'application/json' },
		}));
		const createHttpLink = httpLink.createHttpLink;
		sinon.stub(httpLink, 'createHttpLink').callsFake(options => createHttpLink({ ...options, fetch: graphqlFetch }));
		context = new MockExtensionContext();
		store = new CredentialStore(new MockTelemetry(), context);
		context.subscriptions.push(sessionEvents, store, store.onDidChangeSessions(e => changes.push(e)));
	});

	afterEach(function () {
		context.dispose();
		sinon.restore();
	});

	for (const deployment of [
		{ host: hostB, rest: `${hostB}/api/v3`, graphql: `${hostB}/api/graphql` },
		{ host: `${hostB}:8443/deployment`, rest: `${hostB}:8443/deployment/api/v3`, graphql: `${hostB}:8443/deployment/api/graphql` },
		{ host: 'https://tenant.ghe.com:8443/deployment', rest: 'https://api.tenant.ghe.com:8443/deployment', graphql: 'https://api.tenant.ghe.com:8443/deployment/graphql' },
	]) {
		it(`routes the session token to ${deployment.host} while host A remains configured`, async function () {
			const selectedSession = session(`${deployment.host}/login/oauth`);
			selected.set(AuthProvider.githubEnterprise, selectedSession);
			await store.create({ silent: true });
			const hub = enterpriseHub();

			assert.strictEqual(hub.session, selectedSession);
			assert.strictEqual(hub.serverUri.toString(), vscode.Uri.parse(deployment.host).toString());
			assert.strictEqual(hub.octokit.api.request.endpoint('GET /user').url, `${deployment.rest}/user`);
			assert.deepStrictEqual(await hub.octokit.api.auth(), { type: 'token', token: selectedSession.accessToken, tokenType: 'oauth' });
			await hub.graphql.query({ query: viewerQuery });
			assert.strictEqual(graphqlFetch.firstCall.args[0], deployment.graphql);
			assert.strictEqual(graphqlFetch.firstCall.args[1].headers.authorization, `Bearer ${selectedSession.accessToken}`);
			assert.strictEqual(configuration.calledWith('github-enterprise'), false);
			assert.strictEqual(showError.called, false);
		});
	}

	for (const issuer of [undefined, 'https://github.com/login/oauth']) {
		it(`preserves public routing ${issuer ? 'with' : 'without'} issuer metadata`, async function () {
			selected.set(AuthProvider.github, session(issuer));
			await store.create({ silent: true });
			const hub = store.getHub(AuthProvider.github);
			assert.ok(hub);
			assert.strictEqual(hub.octokit.api.request.endpoint('GET /user').url, 'https://api.github.com/user');
			await hub.graphql.query({ query: viewerQuery });
			assert.strictEqual(graphqlFetch.firstCall.args[0], 'https://api.github.com/graphql');
			assert.strictEqual(store.isAuthenticated(AuthProvider.githubEnterprise), false);
			assert.strictEqual(showError.called, false);
		});
	}

	it('preserves public environment-token authentication', async function () {
		process.env.GITHUB_OAUTH_TOKEN = 'public-test-token';
		await store.create({ silent: true });
		const hub = store.getHub(AuthProvider.github);
		assert.ok(hub);
		assert.strictEqual(hub.session, undefined);
		assert.strictEqual(hub.octokit.api.request.endpoint('GET /user').url, 'https://api.github.com/user');
		assert.strictEqual(getSession.calledWith(AuthProvider.github), false);
	});

	for (const issuer of [undefined, `${hostB}/api/v3`]) {
		it(`reports unavailable enterprise provenance (${issuer ?? 'missing'}) without guessing a host`, async function () {
			selected.set(AuthProvider.githubEnterprise, session(issuer, { account: { id: hostB, label: hostB } }));
			await store.create({ silent: true });
			assert.strictEqual(store.isAuthenticated(AuthProvider.githubEnterprise), false);
			assert.strictEqual(apiCall.called, false);
			assert.strictEqual(showError.calledOnce, true);
			assert.match(showError.firstCall.args[0], /GitHub Enterprise is unavailable.*authorization server/);
			assert.strictEqual(configuration.calledWith('github-enterprise'), false);
		});
	}

	it('replaces cached clients for issuer or token changes, not unchanged sessions', async function () {
		const original = session(`${hostA}/login/oauth`);
		selected.set(AuthProvider.githubEnterprise, original);
		await store.create({ silent: true });
		const firstHub = enterpriseHub();
		await refreshSession(original);
		assert.strictEqual(enterpriseHub(), firstHub);
		assert.strictEqual(changes.length, 0);

		await refreshSession(session(`${hostB}/login/oauth`));
		const secondHub = enterpriseHub();
		assert.notStrictEqual(secondHub, firstHub);
		assert.strictEqual(secondHub.serverUri.toString(), vscode.Uri.parse(hostB).toString());
		await refreshSession(session(`${hostB}/login/oauth`, { accessToken: 'refreshed-token' }));
		assert.notStrictEqual(enterpriseHub(), secondHub);
		assert.deepStrictEqual(changes.map(e => ({ account: e.accountChanged, server: e.serverChanged })), [
			{ account: false, server: true }, { account: false, server: false },
		]);
		await refreshSession();
		assert.strictEqual(store.isAuthenticated(AuthProvider.githubEnterprise), false);
	});

	it('does not overwrite a newer selected connection with an older lookup', async function () {
		let resolveOld!: (value: vscode.AuthenticationSession) => void;
		getSession.onFirstCall().returns(new Promise<vscode.AuthenticationSession>(resolve => resolveOld = resolve));
		const pending = store.create({ silent: true });
		await refreshSession(session(`${hostB}/login/oauth`));
		resolveOld(session(`${hostA}/login/oauth`));
		await pending;
		assert.strictEqual(enterpriseHub().serverUri.toString(), vscode.Uri.parse(hostB).toString());
	});

	it('keeps scope upgrades on the selected account and issuer', async function () {
		const original = session(`${hostB}/login/oauth`);
		selected.set(AuthProvider.githubEnterprise, original);
		await store.create({ silent: true });
		const upgraded = session(`${hostB}/login/oauth`, { id: 'upgraded', scopes: additionalScopes });
		selected.set(AuthProvider.githubEnterprise, upgraded);
		getSession.resetHistory();
		const hub = await store.getHubEnsureAdditionalScopes(AuthProvider.githubEnterprise);
		assert.strictEqual(hub?.session, upgraded);
		assert.deepStrictEqual(getSession.firstCall.args, [AuthProvider.githubEnterprise, additionalScopes, {
			createIfNone: true, account: original.account, authorizationServer: original.authorizationServer,
		}]);
	});

	it('preserves the connection when a scope upgrade is canceled or returns a different issuer', async function () {
		selected.set(AuthProvider.githubEnterprise, session(`${hostB}/login/oauth`));
		await store.create({ silent: true });
		const hub = enterpriseHub();
		const upgrade = getSession.withArgs(AuthProvider.githubEnterprise, additionalScopes);
		upgrade.rejects(new Error('User did not consent to login.'));
		await assert.rejects(store.getHubEnsureAdditionalScopes(AuthProvider.githubEnterprise), /User did not consent/);
		assert.strictEqual(enterpriseHub(), hub);
		upgrade.resolves(session(`${hostA}/login/oauth`, { scopes: additionalScopes }));
		assert.strictEqual(await store.getHubEnsureAdditionalScopes(AuthProvider.githubEnterprise), undefined);
		assert.strictEqual(enterpriseHub(), hub);
		assert.strictEqual(store.isAuthenticatedWithAdditionalScopes(AuthProvider.githubEnterprise), false);
		assert.match(showError.firstCall.args[0], /no longer matches.*account or server/);
	});

	it('matches repositories and server discovery to the selected deployment', async function () {
		selected.set(AuthProvider.githubEnterprise, session(`${hostB}/login/oauth`));
		await store.create({ silent: true });
		const manager = new GitHubManager(store);
		assert.strictEqual(await manager.isGitHub(vscode.Uri.parse(`${hostB}/owner/repo`)), GitHubServerType.Enterprise);
		for (const host of [hostA, hostB]) {
			const remote = parseRemote('origin', `${host}/owner/repo`);
			assert.ok(remote);
			const repo = new GitHubRepository(1, GitHubRemote.remoteAsGitHub(remote, GitHubServerType.Enterprise), context.extensionUri, store, new MockTelemetry(), true);
			context.subscriptions.push(repo);
			if (host === hostA) {
				await assert.rejects(repo.ensure(), /does not match the GitHub server/);
			} else {
				await repo.ensure();
				assert.strictEqual(repo.hub, enterpriseHub());
				await refreshSession(session(`${hostA}/login/oauth`));
				assert.throws(() => repo.hub, /Not authenticated/);
			}
		}
	});

	it('does not reuse repository-search results from another connection', async function () {
		selected.set(AuthProvider.githubEnterprise, session(`${hostA}/login/oauth`));
		await store.create({ silent: true });
		const provider = new GithubRemoteSourceProvider(store, AuthProvider.githubEnterprise);
		apiCall.onCall(apiCall.callCount).resolves({ data: [{ full_name: 'owner/repo', clone_url: `${hostA}/owner/repo`, description: '' }] });
		assert.strictEqual((await provider.getRemoteSources()).length, 1);
		await refreshSession(session(`${hostB}/login/oauth`));
		apiCall.onCall(apiCall.callCount).resolves({ data: { items: [] } });
		assert.deepStrictEqual(await provider.getRemoteSources('query'), []);
	});
});
