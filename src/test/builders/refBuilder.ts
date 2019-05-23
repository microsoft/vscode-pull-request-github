import * as Octokit from '../../common/octokit';
import { Builder } from 'builder-pattern';
import { createRESTUser } from './userBuilder';
import { createRESTRepo } from './repoBuilder';

const templateRESTRef: Octokit.PullRequestsGetResponseHead = {
	label: 'octocat:new-feature',
	ref: 'new-feature',
	user: createRESTUser().build(),
	sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
	repo: createRESTRepo().build(),
};

export function createRESTRef() {
	return Builder(templateRESTRef);
}