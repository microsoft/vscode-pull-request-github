import assert = require('assert');
import { createSandbox, SinonSandbox } from 'sinon';

import { PullRequestManager } from '../../github/pullRequestManager';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { PullRequestModel } from '../../github/pullRequestModel';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { ApiImpl } from '../../api/api1';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: PullRequestManager;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		const telemetry = new MockTelemetry();
		const repository = new MockRepository();
		manager = new PullRequestManager(repository, telemetry, new ApiImpl());
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
			const repository = new GitHubRepository(remote, manager.credentialStore);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
			const pr = new PullRequestModel(repository, remote, prItem);

			manager.activePullRequest = pr;
			assert(changeFired.called);
			assert.deepStrictEqual(manager.activePullRequest, pr);
		});
	});
});