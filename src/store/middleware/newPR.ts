import { IPullRequestManager } from '~/src/github/interface';

import { titleAndBodyFrom } from '~/src/common/utils';

import { setTitle, setBody, CREATE, SET_REPOSITORY, pickBranch, PICK_LOCAL_BRANCH, setUpstream, UPDATE_GITHUB_REMOTES, SET_UPSTREAM, recvRemoteMetadata } from '~/shared/actions';

import Logger from '~/src/common/logger';

import { byOwnerAndName } from '~/src/github/pullRequestManager';

import { Repository } from '~/src/typings/git';
import { Store } from 'redux';
import { State } from '~/shared/state';

export default (manager: IPullRequestManager, {executeCommand}) => (store: Store<State>) => next => {
	manager.getHeadCommitMessage()
		.then(titleAndBodyFrom)
		.then(({title, body}) => {
			next(setTitle(title));
			next(setBody(body));
		})
		.catch(error => {
			Logger.appendLine(error.message);
		});

	return async action => {
		const result = next(action);
		switch (action.type) {
		case CREATE:
			const {request} = store.getState().newPR;
			if (!request) { break; }
			const {data: rsp} = await manager.createPullRequest(request.push.localBranch, request.params);
			Logger.appendLine(JSON.stringify(rsp, null, 2));
			executeCommand('pr.refreshList');
			const pr = await manager.findRepo(byOwnerAndName(
				rsp.base.repo.owner.login,
				rsp.base.repo.name))
				.getPullRequest(+rsp.number);
			executeCommand('pr.openDescription', pr);
			break;
		case SET_REPOSITORY:
			const repo = action.repository as Repository;
			store.dispatch(pickBranch(repo.state.HEAD.name));
			break;
		case PICK_LOCAL_BRANCH:
			try {
				store.dispatch(setUpstream(await manager.getUpstream(action.branch)));
			} catch (noUpstream) {
				ensureUpstream(store);
			}
			break;
		case UPDATE_GITHUB_REMOTES:
			ensureUpstream(store);
			break;
		case SET_UPSTREAM:
			const md = await manager.getMetadata(action.upstream.remote);
			store.dispatch(recvRemoteMetadata(action.upstream.remote, md));
			break;
		}
		return result;
	};
};

const ensureUpstream = store => {
	const {
		selectedLocalBranch: {name: branch},
		gitHubRemotes: remotes
	} = store.getState().spec;
	if (!branch) { return; }
	if (!remotes || !Object.keys(remotes).length) { return; }
	if (remotes.origin) {
		store.dispatch(setUpstream({
			branch,
			remote: 'origin'
		}));
		return;
	}
	store.dispatch(setUpstream({
		branch,
		remote: Object.keys(remotes)[0],
	}));
};