import * as Octokit from '../../common/octokit';
import { Builder } from 'builder-pattern';
import { createRESTUser } from './userBuilder';
import { createRESTRef } from './refBuilder';

const templateRESTPullRequest: Octokit.PullRequestsGetResponse = {
	id: 0,
	node_id: 'node0',
	url: 'https://api.github.com/repos/octocat/reponame/pulls/1347',
	html_url: 'https://github.com/octocat/reponame/pull/1347',
	diff_url: 'https://github.com/octocat/reponame/pull/1347.diff',
	patch_url: 'https://github.com/octocat/reponame/pull/1347.patch',
	issue_url: 'https://api.github.com/repos/octocat/reponame/issues/1347',
	commits_url: 'https://api.github.com/repos/octocat/reponame/pulls/1347/commits',
	review_comments_url: 'https://api.github.com/repos/octocat/reponame/pulls/1347/comments',
	review_comment_url: 'https://api.github.com/repos/octocat/reponame/pulls/comments{/number}',
	comments_url: 'https://api.github.com/repos/octocat/reponame/issues/1347/comments',
	statuses_url: 'https://api.github.com/repos/octocat/reponame/statuses/6dcb09b5b57875f334f61aebed695e2e4193db5e',
	number: 1347,
	state: 'open',
	locked: false,
	title: 'New feature',
	body: 'Please merge thx',
	user: createRESTUser().build(),
	assignee: createRESTUser().build(),
	labels: [],
	active_lock_reason: '',
	created_at: '2019-01-01T08:00:00Z',
	updated_at: '2019-01-01T08:00:00Z',
	closed_at: '',
	merged_at: '',
	merge_commit_sha: '',
	head: createRESTRef().build(),
	base: createRESTRef().build(),
	merged: false,
	mergeable: true,
	merged_by: createRESTUser().build(),
	comments: 10,
	commits: 5,
	additions: 3,
	deletions: 400,
	changed_files: 10,
	maintainer_can_modify: true,
	milestone: null,
	_links: {
		self: {
			href: 'https://api.github.com/repos/octocat/reponame/pulls/1347'
		},
		html: {
			href: 'https://github.com/octocat/reponame/pull/1347'
		},
		issue: {
			href: 'https://api.github.com/repos/octocat/reponame/issues/1347'
		},
		comments: {
			href: 'https://api.github.com/repos/octocat/reponame/issues/1347/comments'
		},
		review_comments: {
			href: 'https://api.github.com/repos/octocat/reponame/pulls/1347/comments'
		},
		review_comment: {
			href: 'https://api.github.com/repos/octocat/reponame/pulls/comments{/number}'
		},
		commits: {
			href: 'https://api.github.com/repos/octocat/reponame/pulls/1347/commits'
		},
		statuses: {
			href: 'https://api.github.com/repos/octocat/reponame/statuses/6dcb09b5b57875f334f61aebed695e2e4193db5e'
		}
	},
};

export function createRESTPullRequest() {
	return Builder(templateRESTPullRequest);
}