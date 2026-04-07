/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { CUSTOM_ENTERPRISE_URI, GITHUB_ENTERPRISE, PR_SETTINGS_NAMESPACE, URI } from '../../common/settingKeys';
import { CredentialStore } from '../../github/credentials';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('CredentialStore', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	const originalGetConfiguration = vscode.workspace.getConfiguration;

	beforeEach(function () {
		sinon = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
	});

	afterEach(function () {
		vscode.workspace.getConfiguration = originalGetConfiguration;
		credentialStore.dispose();
		context.dispose();
		sinon.restore();
	});

	function stubEnterpriseConfiguration(customEnterpriseUri: string, legacyEnterpriseUri: string) {
		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === PR_SETTINGS_NAMESPACE) {
				return {
					get: (key: string, defaultValue?: string) => key === CUSTOM_ENTERPRISE_URI ? (customEnterpriseUri || defaultValue) : defaultValue,
					update: () => Promise.resolve(),
				} as unknown as vscode.WorkspaceConfiguration;
			}

			if (section === GITHUB_ENTERPRISE) {
				return {
					get: (key: string, defaultValue?: string) => key === URI ? (legacyEnterpriseUri || defaultValue) : defaultValue,
					update: () => Promise.resolve(),
				} as unknown as vscode.WorkspaceConfiguration;
			}

			return originalGetConfiguration(section);
		}) as typeof vscode.workspace.getConfiguration;
	}

	function stubCreateHub() {
		sinon.stub(credentialStore as unknown as { createHub: () => Promise<unknown> }, 'createHub').resolves({
			octokit: {},
			graphql: {},
		} as any);
	}

	it('uses secret storage instead of the shared auth provider for the extension enterprise setting', async function () {
		stubEnterpriseConfiguration('https://pr.example.com', '');
		stubCreateHub();
		const getSessionStub = sinon.stub(vscode.authentication, 'getSession').rejects(new Error('should not use shared auth'));
		const inputStub = sinon.stub(vscode.window, 'showInputBox').resolves('secret-token');

		await credentialStore.login(AuthProvider.githubEnterprise);

		assert.strictEqual(inputStub.calledOnce, true);
		assert.strictEqual(getSessionStub.called, false);
		assert.strictEqual(credentialStore.isAuthenticated(AuthProvider.githubEnterprise), true);
		assert.deepStrictEqual(await context.secrets.keys(), ['githubPullRequest.enterpriseToken:pr.example.com']);
	});

	it('prefers the custom extension enterprise setting over the legacy provider when both are present', async function () {
		stubEnterpriseConfiguration('https://pr.example.com', 'https://legacy.example.com');
		stubCreateHub();
		const getSessionStub = sinon.stub(vscode.authentication, 'getSession').rejects(new Error('should not use shared auth'));
		const inputStub = sinon.stub(vscode.window, 'showInputBox').resolves('secret-token');

		await credentialStore.login(AuthProvider.githubEnterprise);

		assert.strictEqual(inputStub.calledOnce, true);
		assert.strictEqual(getSessionStub.called, false);
		assert.deepStrictEqual(await context.secrets.keys(), ['githubPullRequest.enterpriseToken:pr.example.com']);
	});

	it('clears an invalid stored enterprise token and prompts again', async function () {
		stubEnterpriseConfiguration('https://pr.example.com', '');
		const createHubStub = sinon.stub(credentialStore as unknown as { createHub: () => Promise<unknown> }, 'createHub');
		createHubStub.onFirstCall().rejects(new Error('Bad credentials'));
		createHubStub.onSecondCall().resolves({
			octokit: {},
			graphql: {},
		} as any);
		const getSessionStub = sinon.stub(vscode.authentication, 'getSession').rejects(new Error('should not use shared auth'));
		const inputStub = sinon.stub(vscode.window, 'showInputBox');
		inputStub.onFirstCall().resolves('stale-token');
		inputStub.onSecondCall().resolves('fresh-token');

		await credentialStore.login(AuthProvider.githubEnterprise);

		assert.strictEqual(getSessionStub.called, false);
		assert.strictEqual(inputStub.calledTwice, true);
		assert.strictEqual(await context.secrets.get('githubPullRequest.enterpriseToken:pr.example.com'), 'fresh-token');
		assert.strictEqual(credentialStore.isAuthenticated(AuthProvider.githubEnterprise), true);
	});

	it('clears the stored extension enterprise token', async function () {
		stubEnterpriseConfiguration('https://pr.example.com', '');
		stubCreateHub();
		sinon.stub(vscode.window, 'showInputBox').resolves('secret-token');

		await credentialStore.login(AuthProvider.githubEnterprise);
		const cleared = await credentialStore.clearEnterpriseToken();

		assert.strictEqual(cleared, true);
		assert.deepStrictEqual(await context.secrets.keys(), []);
		assert.strictEqual(credentialStore.isAuthenticated(AuthProvider.githubEnterprise), false);
	});

	it('falls back to the shared enterprise auth provider when only the legacy setting is configured', async function () {
		stubEnterpriseConfiguration('', 'https://legacy.example.com');
		stubCreateHub();
		const session = {
			id: 'legacy-session',
			accessToken: 'legacy-token',
			account: { id: 'legacy', label: 'legacy' },
			scopes: ['repo'],
		} as vscode.AuthenticationSession;
		const getSessionStub = sinon.stub(vscode.authentication, 'getSession').resolves(session);
		const inputStub = sinon.stub(vscode.window, 'showInputBox').resolves(undefined);

		await credentialStore.login(AuthProvider.githubEnterprise);

		assert.strictEqual(getSessionStub.called, true);
		assert.strictEqual(inputStub.called, false);
	});

	it('uses the legacy enterprise auth session for copilot when a custom enterprise URI is configured', async function () {
		stubEnterpriseConfiguration('https://pr.example.com', 'https://legacy.example.com');
		const createHubStub = sinon.stub(credentialStore as unknown as { createHub: () => Promise<unknown> }, 'createHub');
		createHubStub.onFirstCall().resolves({ octokit: {}, graphql: {} } as any);
		createHubStub.onSecondCall().resolves({ octokit: { legacy: true }, graphql: {} } as any);
		sinon.stub(vscode.window, 'showInputBox').resolves('secret-token');
		const getSessionStub = sinon.stub(vscode.authentication, 'getSession');
		getSessionStub.withArgs(AuthProvider.githubEnterprise, ['read:user', 'user:email', 'repo', 'workflow', 'project', 'read:org'], { silent: true }).resolves(undefined as any);
		getSessionStub.withArgs(AuthProvider.githubEnterprise, ['read:user', 'user:email', 'repo', 'workflow'], { silent: true }).resolves({
			id: 'legacy-session',
			accessToken: 'legacy-token',
			account: { id: 'legacy', label: 'legacy' },
			scopes: ['repo', 'workflow'],
		} as vscode.AuthenticationSession);

		await credentialStore.login(AuthProvider.githubEnterprise);
		const copilotHub = await credentialStore.getCopilotHub(AuthProvider.githubEnterprise);

		assert.strictEqual(credentialStore.isAuthenticated(AuthProvider.githubEnterprise), true);
		assert.deepStrictEqual(copilotHub, { octokit: { legacy: true }, graphql: {} } as any);
		assert.strictEqual(createHubStub.callCount, 2);
		assert.strictEqual((createHubStub.getCall(1).args as unknown[])[0], 'legacy-token');
		assert.strictEqual(((createHubStub.getCall(1).args as unknown[])[2] as vscode.Uri).authority, 'legacy.example.com');
	});
});