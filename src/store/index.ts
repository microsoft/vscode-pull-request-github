import { Store, createStore, applyMiddleware } from 'redux';

import { State } from '~/shared/state';
import { IPullRequestManager } from '../github/interface';

import reducer from './reducers';
import Logger from '../common/logger';

import newPRMiddleware from './middleware/newPR';

let store: Store<State>;
export default store;

export const init = (manager: IPullRequestManager, commands) =>
	store = createStore<State, any, any, any>(
		reducer,
		applyMiddleware(
			newPRMiddleware(manager, commands),
			_store => next => action => {
				Logger.appendLine(`------ ${action.type} -----`);
				next(action);
				Logger.appendLine(JSON.stringify(store.getState(), null, 2));
				Logger.appendLine(`------ </${action.type}> -----`);
			}
		)
	);