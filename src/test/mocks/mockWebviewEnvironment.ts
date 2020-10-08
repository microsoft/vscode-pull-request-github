import installJsDomGlobal = require('jsdom-global');
import { Suite } from 'mocha';

interface WebviewEnvironmentSetters {
	stateSetter(newState: any): void;
	stateGetter(): any;
	messageAdder(newMessage: any): void;
}

class WebviewVsCodeApi {
	constructor(private readonly _callbacks: WebviewEnvironmentSetters) { }

	postMessage(message: any) {
		this._callbacks.messageAdder(message);
	}

	setState(state: any) {
		this._callbacks.stateSetter(state);
	}

	getState() {
		return this._callbacks.stateGetter();
	}
}

class MockWebviewEnvironment {
	private readonly _api: WebviewVsCodeApi;
	private readonly _messages: any[] = [];
	private _persistedState: any;
	private _uninstall: () => void;

	constructor() {
		this._api = new WebviewVsCodeApi({
			stateSetter: (nState) => {
				this._persistedState = nState;
			},
			stateGetter: () => this._persistedState,
			messageAdder: (newMessage) => {
				this._messages.push(newMessage);
			}
		});

		this._uninstall = () => { };
	}

	install(host: any) {
		const previous = host.acquireVsCodeApi;
		host.acquireVsCodeApi = () => this._api;
		const cleanup = installJsDomGlobal('', {
			runScripts: 'outside-only',
		});

		this._uninstall = () => {
			if (previous) {
				host.acquireVsCodeApi = previous;
			} else {
				delete host.acquireVsCodeApi;
			}
			cleanup();
		};
	}

	uninstall() {
		this._uninstall();
	}

	/**
	 * Install before and after hooks to configure a Mocha test suite to use this Webview environment.
	 *
	 * @param suite The test suite context.
	 *
	 * @example
	 * describe('SomeComponent', function () {
	 *   mockWebviewEnvironment.use(this);
	 *
	 *   it('does something');
	 * });
	 */
	use(suite: Suite) {
		suite.beforeAll(() => this.install(global));
		suite.afterAll(() => this.uninstall());
	}

	/**
	 * Return the most recently persisted state from the Webview.
	 */
	getPersistedState() {
		return this._persistedState;
	}
}

export const mockWebviewEnvironment = new MockWebviewEnvironment();