import { Upstream } from './state';

export const SET_TITLE = 'pr/SET_TITLE';
export const SET_BODY = 'pr/SET_BODY';
export const SET_REPOSITORY = 'pr/SET_REPOSITORY';
export const UPDATE_GITHUB_REMOTES = 'pr/UPDATE_GITHUB_REMOTES';
export const PICK_LOCAL_BRANCH = 'pr/PICK_LOCAL_BRANCH';
export const SET_UPSTREAM = 'pr/SET_UPSTREAM';
export const RECV_REMOTE_METADATA = 'pr/RECV_REMOTE_METADATA';
export const SET_BASE = 'pr/SET_BASE';
export const CREATE = 'pr/CREATE';

export const setTitle = (title: string) => ({ type: SET_TITLE, title });
export const setBody = (body: string) => ({ type: SET_BODY, body });
export const setRepository = (repository: any) => ({ type: SET_REPOSITORY, repository });

export type UpdateGitHubRemotes = {
	type: 'pr/UPDATE_GITHUB_REMOTES';
	remotes: any[]
};
export const updateGitHubRemotes = (remotes: any[]): UpdateGitHubRemotes => ({
	type: UPDATE_GITHUB_REMOTES,
	remotes
});

export const pickBranch = (branch: string) => ({ type: PICK_LOCAL_BRANCH, branch });

export type SetUpstream = {
	type: 'pr/SET_UPSTREAM';
	upstream: Upstream;
};
export const setUpstream = (upstream: Upstream): SetUpstream => ({
	type: SET_UPSTREAM,
	upstream
});

export type RecvRemoteMetadata = {
	type: 'pr/RECV_REMOTE_METADATA';
	remote: string;
	metadata: any;
};
export const recvRemoteMetadata = (remote: string, metadata: any): RecvRemoteMetadata => ({
	type: RECV_REMOTE_METADATA,
	remote, metadata
});

export type SetBase = {
	type: 'pr/SET_BASE';
	isParent: boolean;
};
export const setBase = (isParent: boolean) => ({
	type: SET_BASE,
	isParent,
});