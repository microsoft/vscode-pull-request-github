import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { FolderRepositoryManager, titleAndBodyFrom } from '../../github/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { PullRequestModel } from '../../github/pullRequestModel';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockSessionState } from '../mocks/mockSessionState';
import { Uri } from 'vscode';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		const repository = new MockRepository();
		const credentialStore = new CredentialStore(telemetry);
		const context = new MockExtensionContext();
		manager = new FolderRepositoryManager(context, repository, telemetry, new GitApiImpl(), credentialStore, new MockSessionState());
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('activePullRequest', function () {
		it('gets and sets the active pull request', function () {
			assert.strictEqual(manager.activePullRequest, undefined);

			const changeFired = sinon.spy();
			manager.onDidChangeActivePullRequest(changeFired);

			const url = 'https://github.com/aaa/bbb.git';
			const protocol = new Protocol(url);
			const remote = new Remote('origin', url, protocol);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const repository = new GitHubRepository(remote, rootUri, manager.credentialStore, telemetry, new MockSessionState());
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
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
