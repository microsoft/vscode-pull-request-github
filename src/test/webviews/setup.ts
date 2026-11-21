/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, afterEach, beforeEach } from 'mocha';
import { cleanup } from 'react-testing-library';
import { SinonSpy, spy } from 'sinon';
import { mockWebviewEnvironment } from '../mocks/mockWebviewEnvironment';

mockWebviewEnvironment.install(globalThis);
let listeners: SinonSpy;
beforeEach(() => {
	mockWebviewEnvironment.reset();
	listeners = spy(window, 'addEventListener');
});
afterEach(() => {
	cleanup();
	for (const call of listeners.getCalls()) {
		window.removeEventListener(call.args[0], call.args[1], call.args[2]);
	}
	listeners.restore();
	window.onscroll = null;
});
after(() => mockWebviewEnvironment.uninstall());

window.scrollTo = () => { };
window.matchMedia = media => ({
	media,
	matches: false,
	onchange: null,
	addListener() { },
	removeListener() { },
	addEventListener() { },
	removeEventListener() { },
	dispatchEvent() { return true; },
});

// JSDOM has no layout engine; tests can replace these observers to simulate layout changes.
globalThis.ResizeObserver = class implements ResizeObserver {
	observe() { }
	unobserve() { }
	disconnect() { }
};

globalThis.IntersectionObserver = class implements IntersectionObserver {
	readonly root = null;
	readonly rootMargin = '0px';
	readonly thresholds: readonly number[] = [];
	observe() { }
	unobserve() { }
	disconnect() { }
	takeRecords(): IntersectionObserverEntry[] { return []; }
};
