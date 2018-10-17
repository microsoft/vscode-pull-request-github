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
export const updateGitHubRemotes = (remotes: any[]) => ({ type: UPDATE_GITHUB_REMOTES, remotes });
export const pickBranch = (branch: string) => ({ type: PICK_LOCAL_BRANCH, branch });
export const setUpstream = upstream => ({ type: SET_UPSTREAM, upstream });
export const recvRemoteMetadata = (remote, metadata) => ({
	type: RECV_REMOTE_METADATA,
	remote, metadata
});
export const setBase = (isParent: boolean) => ({
	type: SET_BASE,
	isParent,
});