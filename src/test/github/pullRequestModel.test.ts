import * as assert from 'assert';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestStateEnum } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';

const telemetry = {
	on: (action) => Promise.resolve(),
	shutdown: () => Promise.resolve()
};
const credentials = new CredentialStore(null, telemetry);
const protocol = new Protocol('');
const remote = new Remote('test', 'github/test', protocol);
const repo = new GitHubRepository(remote, credentials);
const pr = {
	additions: 1,
	assignee: 'me',
	assignees: ['me'],
	author_association: '',
	base: {
		label: '',
		ref: '',
		repo: {
			clone_url: ''
		},
		sha: '',
	},
	body: 'My PR body.',
	boolean: '',
	changed_files: 1,
	closed_at: '',
	comments: 0,
	commits: 1,
	created_at: '',
	head: {
		label: '',
		ref: '',
		repo: {
			clone_url: ''
		},
		sha: '',
	},
	html_url: '',
	id: 1,
	labels: [],
	locked: false,
	maintainer_can_modify: true,
	merge_commit_sha: '',
	mergable: true,
	merged: false,
	number: 1,
	rebaseable: true,
	state: 'open' as 'open',
	title: 'My PR title.',
	updated_at: '',
	user: 'me',
};

describe('PullRequestModel', () => {
	it('should return `state` properly as `open`', () => {
		const open = new PullRequestModel(repo, remote, pr);

		assert.equal(open.state, PullRequestStateEnum.Open);
	});

	it('should return `state` properly as `closed`', () => {
		const open = new PullRequestModel(repo, remote, { ...pr, state: 'closed' });

		assert.equal(open.state, PullRequestStateEnum.Closed);
	});

	it('should return `state` properly as `merged`', () => {
		const open = new PullRequestModel(repo, remote, { ...pr, merged: true, state: 'closed' });

		assert.equal(open.state, PullRequestStateEnum.Merged);
	});
});
