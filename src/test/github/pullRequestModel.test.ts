import assert = require('assert');
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GithubItemStateEnum } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { SinonSandbox, createSandbox } from 'sinon';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockTelemetry } from '../mocks/mockTelemetry';

const telemetry = new MockTelemetry();
const protocol = new Protocol('https://github.com/github/test.git');
const remote = new Remote('test', 'github/test', protocol);

describe('PullRequestModel', function () {
	let sinon: SinonSandbox;
	let credentials: CredentialStore;
	let repo: GitHubRepository;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		credentials = new CredentialStore(telemetry);
		repo = new GitHubRepository(remote, credentials, telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	it('should return `state` properly as `open`', function () {
		const pr = new PullRequestBuilder().state('open').build();
		const open = new PullRequestModel(telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, GithubItemStateEnum.Open);
	});

	it('should return `state` properly as `closed`', function () {
		const pr = new PullRequestBuilder().state('closed').build();
		const open = new PullRequestModel(telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, GithubItemStateEnum.Closed);
	});

	it('should return `state` properly as `merged`', function () {
		const pr = new PullRequestBuilder().merged(true).state('closed').build();
		const open = new PullRequestModel(telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.equal(open.state, GithubItemStateEnum.Merged);
	});
});
