import {
	SET_REPOSITORY,
	PICK_LOCAL_BRANCH,
	SET_UPSTREAM,
	SET_TITLE,
	SET_BODY,
	SET_BASE } from '~/shared/actions';
import { combineReducers } from 'redux';
import { PullRequestsCreateParams } from '@octokit/rest';
import { NewPRState, NewPRSpecState, GitHubRemotesState, Upstream, State, NewPRRequest } from '~/shared/state';

const initialState: NewPRState = {
	spec: {
		title: '',
		body: '',
		branch: null,
		parentIsBase: false,
	},
};

export default (state = initialState, action, {gitHubRemotes}: State) => {
	const spec = specification(state.spec, action);
	const errors = check(spec, gitHubRemotes);
	const request = !errors ? generateRequest(spec, gitHubRemotes) : null;
	return {spec, errors, request};
};

const branchReducer = (state: { name?: string, upstream?: Upstream } = {}, { type, branch, upstream }) =>
	type === SET_REPOSITORY
		? {}
		:
	type === PICK_LOCAL_BRANCH
		? { name: branch, upstream: null }
		:
	type === SET_UPSTREAM
		? { ...state, upstream }
		: state;

const titleReducer = (state = '', { type, title }) =>
	type === SET_TITLE
		? title
		: state;

const bodyReducer = (state = '', { type, body }) =>
	type === SET_BODY
		? body
		: state;

const parentIsBase = (state = false, { type, isParent }) =>
	type === SET_BASE
		? isParent
		: state;

const specification = combineReducers({
	title: titleReducer,
	body: bodyReducer,
	branch: branchReducer,
	parentIsBase,
});

export const check = (spec: NewPRSpecState, remotes: GitHubRemotesState) =>
	!spec.title
		? { title: 'Enter a title' }
		:
	!spec.body
		? { body: 'Enter a body' }
		:
	!spec.branch || !spec.branch.name
		? { branch: 'Select a branch' }
		:
	!spec.branch.upstream || !spec.branch.upstream.remote
		? { branch: 'Select a remote' }
		:
	!remotes
		? { branch: 'Fetching data...' }
		:
	!remotes[spec.branch.upstream.remote]
		? { branch: 'Select a GitHub repository' }
		:
	!remotes[spec.branch.upstream.remote].metadata
		? { branch: 'Waiting for repository metadata' }
		: null;

const generateRequest = ({
	title, body,
	branch,
	parentIsBase: isParent
}: NewPRSpecState, remotes: GitHubRemotesState): NewPRRequest => {
	const origin = remotes[branch.upstream.remote].metadata;
	const upstream = (isParent && origin.parent) ? origin.parent : origin;
	const base = upstream.default_branch as string;
	const head: string = upstream === origin
		? branch.name
		: `${origin.owner.login}:${branch.name}`;
	const repo: string = upstream.name;
	const owner: string = upstream.owner.login;
	return {
		user: origin.currentUser,
		push: {
			localBranch: branch.name,
			remoteBranch: branch.upstream.branch || branch.name,
			remote: branch.upstream.remote,
		},
		params: { title, body, base, head, repo, owner },
	};
};