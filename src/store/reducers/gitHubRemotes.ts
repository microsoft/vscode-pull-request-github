import { SET_REPOSITORY, UPDATE_GITHUB_REMOTES, RECV_REMOTE_METADATA, UpdateGitHubRemotes, RecvRemoteMetadata } from '~/shared/actions';
import { GitHubRepository } from '~/src/github/githubRepository';
import { GitHubRemote } from '~/shared/state';

import Reducer from '../handler';

export default Reducer<{[remoteName: string]: GitHubRemote}>({})
	.on(SET_REPOSITORY, () => ({}))
	.on(UPDATE_GITHUB_REMOTES, (_state, action: UpdateGitHubRemotes) =>
		(action.remotes as GitHubRepository[])
			.reduce((remotes, { remote: { remoteName, repositoryName, owner, host } }) => {
				remotes[remoteName] = {
					name: repositoryName,
					owner,
					host,
				};
				return remotes;
			}, {})
	)
	.on(RECV_REMOTE_METADATA, (state, {remote, metadata}: RecvRemoteMetadata) => ({
		...state,
		[remote]: {
			...state[remote],
			metadata
		}
	}));
