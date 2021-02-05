/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vscode } from './message';
import { createContext } from 'react';
import { getMessageHandler, MessageHandler } from './message';

interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

export interface CreateParams {
	availableRemotes: RemoteInfo[];
	branchesForRemote: string[];

	pendingTitle?: string;
	pendingDescription?: string;
	baseRemote?: RemoteInfo;
	baseBranch?: string;
	compareBranch?: string;
	isDraft: boolean;

	validate: boolean;
	showTitleValidationError: boolean;
	createError?: boolean;

}

const defaultCreateParams: CreateParams = {
	availableRemotes: [],
	branchesForRemote: [],
	validate: false,
	showTitleValidationError: false,
	isDraft: false
};

export class CreatePRContext {
	constructor(
		public createParams: CreateParams = vscode.getState() || defaultCreateParams,
		public onchange: ((ctx: CreateParams) => void) | null = null,
		private _handler: MessageHandler = null) {
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	public cancelCreate = (): Promise<void> => {
		vscode.setState(defaultCreateParams);
		return this.postMessage({ command: 'pr.cancelCreate' });
	}

	public updateState = (params: Partial<CreateParams>): void => {
		this.createParams = { ...this.createParams, ...params };
		vscode.setState(this.createParams);
		if (this.onchange) { this.onchange(this.createParams); }
	}

	public changeBaseRemote = async (owner: string, repositoryName: string): Promise<void> => {
		const response = await this.postMessage({
			command: 'pr.changeBaseRemote',
			args: {
				owner,
				repositoryName
			}
		});

		this.updateState({ baseRemote: { owner, repositoryName }, branchesForRemote: response.branches, baseBranch:  response.defaultBranch });
	}

	public changeBaseBranch = async (branch: string): Promise<void> => {
		this.postMessage({ command: 'pr.changeBaseBranch', args: branch });
	}

	public changeCompareBranch = async (branch: string): Promise<void> => {
		this.postMessage({ command: 'pr.changeCompareBranch', args: branch });
	}

	public validate = (): boolean => {
		let isValid = true;
		if (!this.createParams.pendingTitle) {
			this.updateState({ showTitleValidationError: true });
			isValid = false;
		}

		this.updateState({ validate: true, createError: undefined });

		return isValid;
	}

	public submit = async (): Promise<void> => {
		try {
			await this.postMessage({
				command: 'pr.create',
				args: {
					title: this.createParams.pendingTitle,
					body: this.createParams.pendingDescription,
					owner: this.createParams.baseRemote.owner,
					repo: this.createParams.baseRemote.repositoryName,
					base: this.createParams.baseBranch,
					draft: this.createParams.isDraft

				}
			});
			vscode.setState(defaultCreateParams);
		} catch (e) {
			this.updateState({ createError: e });
		}
	}

	postMessage = (message: any): Promise<any> => {
		return this._handler.postMessage(message);
	}

	handleMessage = (message: any): void => {
		switch (message.command) {
			case 'pr.initialize':
				if (this.createParams.pendingTitle === undefined) {
					message.params.pendingTitle = message.params.defaultTitle;
				}

				if (this.createParams.pendingDescription === undefined) {
					message.params.pendingDescription = message.params.defaultDescription;
				}

				if (this.createParams.baseRemote === undefined) {
					message.params.baseRemote = message.params.defaultRemote;
				} else {
					// Notify the extension of the stored selected remote state
					this.changeBaseRemote(this.createParams.baseRemote.owner, this.createParams.baseRemote.repositoryName);
				}

				if (this.createParams.baseBranch === undefined) {
					message.params.baseBranch = message.params.defaultBranch;
				} else {
					// Notify the extension of the stored base branch state
					this.changeBaseBranch(this.createParams.baseBranch);
				}

				if (this.createParams.compareBranch === undefined) {
					message.params.compareBranch = message.params.compareBranch;
				} else {
					// Notify the extension of the stored compare branch state
					this.changeCompareBranch(this.createParams.compareBranch);
				}

				this.updateState(message.params);
				return;
			case 'reset':
				message.params.pendingTitle = message.params.defaultTitle;
				message.params.pendingDescription = message.params.defaultDescription;
				message.params.baseRemote = message.params.defaultRemote;
				message.params.baseBranch = message.params.defaultBranch;
				this.updateState(message.params);
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		}
	}

	public static instance = new CreatePRContext();
}

const PullRequestContext = createContext<CreatePRContext>(CreatePRContext.instance);
export default PullRequestContext;
