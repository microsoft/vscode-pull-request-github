import * as assert from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { PullRequestManager } from '../../github/pullRequestManager';
import { MockRepository } from '../mocks/mock-repository';
import { MockTelemetry } from '../mocks/mock-telemetry';
import { MockCommandRegistry } from '../mocks/mock-command-registry';
import { PullRequestModel } from '../../github/pullRequestModel';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { CredentialStore } from '../../github/credentials';
import { createRESTPullRequest } from '../builders/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';

describe('PullRequestManager', function() {
	let sinon: SinonSandbox;
	let manager: PullRequestManager;

	beforeEach(function() {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		const telemetry = new MockTelemetry();
		const repository = new MockRepository();
		manager = new PullRequestManager(repository, telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('activePullRequest', function() {
		it('gets and sets the active pull request', function() {
			assert.strictEqual(manager.activePullRequest, undefined);

			const changeFired = sinon.spy();
			manager.onDidChangeActivePullRequest(changeFired);

			const url = 'https://github.com/aaa/bbb.git';
			const protocol = new Protocol(url);
			const remote = new Remote('origin', url, protocol);
			const repository = new GitHubRepository(remote, manager.credentialStore);
			const prItem = convertRESTPullRequestToRawPullRequest(createRESTPullRequest().build(), repository);
			const pr = new PullRequestModel(repository, remote, prItem);

			manager.activePullRequest = pr;
			assert(changeFired.called);
			assert.deepStrictEqual(manager.activePullRequest, pr);
		});
	});
});