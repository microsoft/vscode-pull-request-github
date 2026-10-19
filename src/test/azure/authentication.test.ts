/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Buffer } from 'buffer';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AzureAuthentication } from '../../azure/authentication';
import { AzureClient } from '../../azure/client';
import { InMemoryMemento } from '../mocks/inMemoryMemento';

describe('Azure DevOps authentication', () => {
	let sandbox: SinonSandbox;
	let globalState: InMemoryMemento;
	let secrets: Map<string, string>;
	let authentication: AzureAuthentication;
	const remote = { organizationUrl: 'https://dev.azure.com/example', project: 'Project', repository: 'Repo' };
	const session: vscode.AuthenticationSession = { id: 'session', accessToken: 'access-token', account: { id: 'account', label: 'Example' }, scopes: [] };
	const key = 'azureDevOps.pat:https://dev.azure.com/example';

	beforeEach(() => {
		sandbox = createSandbox();
		globalState = new InMemoryMemento();
		secrets = new Map();
		authentication = new AzureAuthentication({
			globalState,
			secrets: {
				get: async key => secrets.get(key),
				store: async (key, value) => { secrets.set(key, value); },
				delete: async key => { secrets.delete(key); },
				onDidChange: () => ({ dispose() { } }),
			},
		});
	});

	afterEach(() => sandbox.restore());

	it('retrieves an organization-scoped PAT from secret storage', async () => {
		secrets.set(key, 'personal-token');
		const getSession = sandbox.stub(vscode.authentication, 'getSession');
		assert.strictEqual(await authentication.authorization(remote), `Basic ${Buffer.from(':personal-token').toString('base64')}`);
		assert.strictEqual(getSession.called, false);
		assert.strictEqual(globalState.get(key), undefined);
	});

	it('does not reuse a PAT for another organization', async () => {
		secrets.set(key, 'personal-token');
		sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
		await assert.rejects(authentication.authorization({ ...remote, organizationUrl: 'https://dev.azure.com/other' }), /Sign in/);
	});

	it('uses silent Microsoft authentication with the Azure DevOps resource scope', async () => {
		const getSession = sandbox.stub(vscode.authentication, 'getSession').resolves(session);
		assert.strictEqual(await authentication.authorization(remote), 'Bearer access-token');
		assert.deepStrictEqual(getSession.firstCall.args, ['microsoft', ['499b84ac-1321-427f-aa17-267ca6975798/.default'], { silent: true }]);
	});

	it('does not try Microsoft tokens for a configured on-premises collection', async () => {
		const getSession = sandbox.stub(vscode.authentication, 'getSession');
		await assert.rejects(authentication.authorization({ ...remote, organizationUrl: 'https://server.example/tfs/Collection' }), /Sign in/);
		assert.strictEqual(getSession.called, false);
	});

	it('validates a new PAT before storing it', async () => {
		sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Personal access token' });
		sandbox.stub(vscode.window, 'showInputBox').resolves('  valid-token  ');
		const validate = sandbox.stub(AzureClient.prototype, 'currentUser').callsFake(async function () {
			assert.strictEqual(secrets.size, 0);
			return { id: 'user', displayName: 'Example' };
		});
		assert.strictEqual(await authentication.signIn(remote), true);
		assert.strictEqual(validate.calledOnce, true);
		assert.strictEqual(secrets.get(key), 'valid-token');
		assert.strictEqual(globalState.get(`${key}:signedOut`, false), false);
	});

	it('leaves the existing token intact when new credentials are rejected', async () => {
		secrets.set(key, 'previous-token');
		sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Personal access token' });
		sandbox.stub(vscode.window, 'showInputBox').resolves('invalid-token');
		sandbox.stub(AzureClient.prototype, 'currentUser').rejects(new Error('HTTP 401'));
		await assert.rejects(authentication.signIn(remote), /HTTP 401/);
		assert.strictEqual(secrets.get(key), 'previous-token');
	});

	it('does not change credentials when sign-in is canceled', async () => {
		sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);
		assert.strictEqual(await authentication.signIn(remote), false);
		assert.strictEqual(secrets.size, 0);
	});

	it('removes PATs when switching to Microsoft authentication', async () => {
		secrets.set(key, 'previous-token');
		sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Microsoft account' });
		sandbox.stub(vscode.authentication, 'getSession').resolves(session);
		sandbox.stub(AzureClient.prototype, 'currentUser').resolves({ id: 'user', displayName: 'Example' });
		assert.strictEqual(await authentication.signIn(remote), true);
		assert.strictEqual(secrets.has(key), false);
	});

	it('signs out locally without silently signing back into a shared Microsoft session', async () => {
		secrets.set(key, 'personal-token');
		const getSession = sandbox.stub(vscode.authentication, 'getSession').resolves(session);
		await authentication.signOut(remote);
		assert.strictEqual(secrets.has(key), false);
		await assert.rejects(authentication.authorization(remote), /Sign in/);
		assert.strictEqual(getSession.called, false);
	});
});
