import * as React from 'react';

import { createContext } from 'react';
import { getMessageHandler, MessageHandler } from './message';
import { PullRequest, getState, setState } from './cache';

export class PRContext {
	constructor(
		public pr: PullRequest = getState(),
		public onchange: ((ctx: PullRequest) => void) | null = null,
		private _handler: MessageHandler = null) {
		if (!_handler) {
			console.log('init message handler', this.handleMessage);
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	public checkout(this: PRContext): Promise<void> {
		return this.postMessage({ command: 'pr.checkout' });
	}

	public async exitReviewMode(this: PRContext): Promise<void> {
		console.log('Exit', this.pr, this.pr && this.pr.repositoryDefaultBranch, this.postMessage);
		if (!this.pr) { return; }
		console.log(this.pr.repositoryDefaultBranch);
		return this.postMessage({
			command: 'pr.checkout-default-branch',
			args: this.pr.repositoryDefaultBranch,
		});
	}

	public refresh() {
		return this.postMessage({ command: 'pr.refresh' });
	}

	setPR(pr: PullRequest) {
		this.pr = pr;
		setState(this.pr);
		if (this.onchange) { this.onchange(this.pr); }
		return this;
	}

	updatePR(pr: Partial<PullRequest>) {
		return this.setPR({...this.pr, ...pr });
	}

	private postMessage(message: any) {
		return this._handler.postMessage(message);
	}

	handleMessage = (message: any) => {
		console.log('message from host:', message);
		switch (message.command) {
			case 'pr.initialize':
				return this.setPR(message.pullrequest);
			case 'update-state':
				return this.updatePR({ state: message.state });
			case 'pr.update-checkout-status':
				return this.updatePR({ isCurrentlyCheckedOut: message.isCurrentlyCheckedOut });
			case 'pr.enable-exit':
				return this.updatePR({ isCurrentlyCheckedOut: true });
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		}
	}

	public static instance = new PRContext();
}

const Context = createContext<PRContext>(PRContext.instance);
export default Context;
