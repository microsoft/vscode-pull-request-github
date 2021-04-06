import assert = require('assert');
import { createSandbox, SinonSandbox } from 'sinon';
import { createMock } from 'ts-auto-mock';
import { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

import { FolderRepositoryManager, titleAndBodyFrom } from '../../azdo/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { AzdoRepository } from '../../azdo/azdoRepository';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../azdo/credentials';
import { createFakeSecretStorage } from '../mocks/mockExtensionContext';
import { convertAzdoPullRequestToRawPullRequest } from '../../azdo/utils';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		const repository = new MockRepository();
		const secretStorage = createFakeSecretStorage();
		const credentialStore = new CredentialStore(telemetry, secretStorage);
		manager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('activePullRequest', function () {
		it('gets and sets the active pull request', async function () {
			assert.strictEqual(manager.activePullRequest, undefined);

			const changeFired = sinon.spy();
			manager.onDidChangeActivePullRequest(changeFired);

			const url = 'https://dev.azure.com.com/aaa/bbb/_git/bbb';
			const protocol = new Protocol(url);
			const remote = new Remote('origin', url, protocol);
			const repository = new AzdoRepository(remote, manager.credentialStore, telemetry);
			const prItem = await convertAzdoPullRequestToRawPullRequest(createMock<GitPullRequest>(), repository);
			const pr = new PullRequestModel(telemetry, repository, remote, prItem);

			manager.activePullRequest = pr;
			assert(changeFired.called);
			assert.deepStrictEqual(manager.activePullRequest, pr);
		});
	});
});

describe('titleAndBodyFrom', function () {
	it('separates title and body', function () {
		const message = 'title\n\ndescription 1\n\ndescription 2\n';

		const { title, body } = titleAndBodyFrom(message);
		assert.strictEqual(title, 'title');
		assert.strictEqual(body, 'description 1\n\ndescription 2');
	});

	it('returns only title with no body', function () {
		const message = 'title';

		const { title, body } = titleAndBodyFrom(message);
		assert.strictEqual(title, 'title');
		assert.strictEqual(body, '');
	});

	it('returns only title when body contains only whitespace', function () {
		const message = 'title\n\n';

		const { title, body } = titleAndBodyFrom(message);
		assert.strictEqual(title, 'title');
		assert.strictEqual(body, '');
	});
});
