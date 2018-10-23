import { State } from '~/shared/state';
import { combineReducers } from '../handler';

import localBranches from './localBranches';
import newPR from './newPR';
import gitHubRemotes from './gitHubRemotes';

export default combineReducers<State>({
	localBranches,
	gitHubRemotes,
	newPR,
});
