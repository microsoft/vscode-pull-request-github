import assert = require('assert');
import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';

import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockKeytar } from '../mocks/mockKeytar';
import { CredentialStore } from '../../github/credentials';
import { handler as uriHandler } from '../../common/uri';
import { init as initKeytar, getToken } from '../../authentication/keychain';
import { MockExtensionContext } from '../mocks/mockExtensionContext';

describe('CredentialStore', function() {
	let sinon: SinonSandbox;
	let commands: MockCommandRegistry;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;

	beforeEach(function() {
		sinon = createSandbox();
		context = new MockExtensionContext();

		commands = new MockCommandRegistry(sinon);
		telemetry = new MockTelemetry();
		const keytar = new MockKeytar();
		initKeytar(context, keytar);
	});

	afterEach(function() {
		context.dispose();
		sinon.restore();
	});

	describe('the auth.inputTokenCallback command', function() {
		it('aborts if no token or URI are provided', async function() {
			const showStub = sinon.stub(vscode.window, 'showInputBox').resolves(undefined);

			const credentialStore = new CredentialStore(telemetry);
			await commands.executeCommand('auth.inputTokenCallback');
			assert(showStub.called);

			credentialStore.dispose();
		});

		it('fires a UriHandler event if a URI is provided', async function() {
			sinon.stub(vscode.window, 'showInputBox').resolves('https://github.com');

			const callback = sinon.spy();
			uriHandler.event(callback);

			const credentialStore = new CredentialStore(telemetry);
			await commands.executeCommand('auth.inputTokenCallback');

			assert(callback.calledOnce);
			assert(callback.firstCall.args[0].authority, 'github.com');

			credentialStore.dispose();
		});

		it('prompts for a host if a token is provided', async function() {
			sinon.stub(vscode.window, 'showInputBox').callsFake((options) => {
				if (options && options.prompt === 'Token') {
					return Promise.resolve('12345');
				} else if (options && options.prompt === 'Server') {
					return Promise.resolve('github.enterprise.horse');
				} else {
					return Promise.reject(new Error(`Unexpected showInputBox call: ${options && options.prompt}`));
				}
			});

			const credentialStore = new CredentialStore(telemetry);
			await commands.executeCommand('auth.inputTokenCallback');

			assert.strictEqual(await getToken('github.enterprise.horse'), '12345');

			credentialStore.dispose();
		});
	});
});