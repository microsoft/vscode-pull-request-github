import { Store as ReduxStore, createStore, applyMiddleware, AnyAction } from 'redux';

import { State } from '~/shared/state';
import { IPullRequestManager } from '../github/interface';

import reducer from './reducers';
import Logger from '../common/logger';

import newPRMiddleware from './middleware/newPR';
import { Disposable, Event } from 'vscode';
import { init } from './actions';

export class Store {
	public static dispatch(action: AnyAction) {
		return this.store.dispatch(action);
	}

	public static get state(): State { return this.store.getState(); }

	public static onState: Event<State> = (listener: (State) => void, disposables?): Disposable => {
		const disposable: Disposable = {
			dispose: Store.store.subscribe(() => listener(Store.store.getState()))
		};
		if (disposables) { disposables.push(disposable); }
		return disposable;
	}

	public static store: ReduxStore<State>;

	static init(manager: IPullRequestManager, {window, commands}, disposables=[]) {
		const store = createStore<State, any, any, any>(
			reducer,
			applyMiddleware(
				_store => next => async action => {
					try {
						return await next(action);
					} catch (error) {
						window.showErrorMessage(error.message);
					}
				},
				newPRMiddleware(manager, commands),
				_store => next => action => {
					Logger.appendLine(`------ ${action.type} -----`);
					next(action);
					Logger.appendLine(JSON.stringify(store.getState(), null, 2));
					Logger.appendLine(`------ </${action.type}> -----`);
				}
			)
		);
		this.store = store;
		this.dispatch(init);
	}
}