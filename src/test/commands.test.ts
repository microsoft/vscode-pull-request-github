import * as assert from 'assert';
import * as vscode from 'vscode';

import { registerCommands } from '../commands';
import { MockExtensionContext, MockTelemetry, MockRepository, MockKeytar, createSinonSandbox } from './helpers';
import { PullRequestManager } from '../github/pullRequestManager';
import { ReviewManager } from '../view/reviewManager';
import { PullRequestsTreeDataProvider } from '../view/prsTreeDataProvider';
import { Keytar, init as initKeytar, setToken, listHosts } from '../authentication/keychain';

describe('Command registration', function() {
	let context: MockExtensionContext;
	let repository: MockRepository;
	let prManager: PullRequestManager;
	let prTreeManager: PullRequestsTreeDataProvider;
	let reviewManager: ReviewManager;
	let telemetry: MockTelemetry;

	const sinon = createSinonSandbox(this);

	beforeEach(function() {
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		repository = new MockRepository();

		prManager = new PullRequestManager(repository, telemetry);
		context.subscriptions.push(prManager);

		prTreeManager = new PullRequestsTreeDataProvider(telemetry);
		reviewManager = new ReviewManager(context, repository, prManager, prTreeManager, telemetry);

		registerCommands(context, prManager, reviewManager, telemetry);
	});

	afterEach(function() {
		context.dispose();
	});

	describe('auth.signout', function() {
		let keytar: Keytar;

		beforeEach(async function() {
			keytar = new MockKeytar();
			initKeytar(context, keytar);

			await setToken('aaa.com', '1111');
			await setToken('bbb.com', '2222');
			await setToken('ccc.com', '3333');
		});

		it('deletes the tokens associated with each selected host', async function() {
			(sinon.stub(vscode.window, 'showQuickPick') as any).resolves(['aaa.com', 'ccc.com']);

			await vscode.commands.executeCommand('auth.signout');

			assert.deepEqual(await listHosts(), ['bbb.com']);
		});

		it('does nothing when no host is selected');
	});
});