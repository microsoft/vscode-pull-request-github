import { Action as ReduxAction } from 'redux';

export type Reducer<S = any, C = any, A = Action> = (
	state: S | undefined,
	action: A,
	context?: C,
) => S;

export interface Action extends ReduxAction<string> {
	[anyProp: string]: any;
}

interface HandlerChain<S = any, C = any, A extends Action = Action> extends Reducer<S, C, A> {
	on<B extends Action>(type: string, reducer: Reducer<S, C, B>): HandlerChain<S, C, A & B>;
}

type Handlers<State> = {
	[type: string]: Reducer<State>;
};

const Handler: <S=any>(initial: S) => HandlerChain<S> =
	<S, C = any, A extends Action = Action>(initial) => {
		const handlers: Handlers<S> = {};
		const handleAction = (state=initial, action: Action, context?: C) => {
			const handler = handlers[action.type];
			return handler ? handler(state, action, context) : state;
		};
		handleAction.on =
			<B extends A>(type: string, reducer: Reducer<S, C, B>):
			HandlerChain<S, C, Action & B> => {
			handlers[type] = reducer;
			return handleAction as HandlerChain<S, C, A & B>;
		};
		return handleAction;
	};

export default Handler;

/**
 * Object whose values correspond to different reducer functions.
 *
 * @template A The type of actions the reducers can potentially respond to.
 */
export type ReducersMapObject<S = any, A extends Action = Action> = {
	[K in keyof S]: Reducer<S[K], S, A>
};

export const combineReducers:
	<S=any>(reducers: ReducersMapObject<S>) =>
	(state: S, action: Action) => S =
	<State=any>(reducers: ReducersMapObject<State>) => {
		const keys = Object.keys(reducers);
		return (state: State, action: Action) => {
			let nextState = state;
			let hasCopied = false;
			let k = keys.length; while (k --> 0) {
				const key = keys[k];
				const stateForKey = state[key];
				const reducerForKey = reducers[key];
				const nextStateForKey = reducerForKey(stateForKey, action, state);
				if (nextStateForKey !== stateForKey) {
					if (!hasCopied) { nextState = Object.assign({}, state); }
					nextState[key] = nextStateForKey;
				}
			}
			return nextState;
		};
	};