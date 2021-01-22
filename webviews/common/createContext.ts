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
	selectedRemote?: RemoteInfo;
	selectedBranch?: string;
	compareBranch?: string;

	validate: boolean;
	showTitleValidationError: boolean;
	showDescriptionValidationError: boolean;
	createError?: boolean;

}

const defaultCreateParams: CreateParams = {
	availableRemotes: [],
	branchesForRemote: [],
	validate: false,
	showTitleValidationError: false,
	showDescriptionValidationError: false
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

	public changeRemote = async (owner: string, repositoryName: string): Promise<void> => {
		const response = await this.postMessage({
			command: 'pr.changeRemote',
			args: {
				owner,
				repositoryName
			}
		});

		this.updateState({ selectedRemote: { owner, repositoryName }, branchesForRemote: response.branches, selectedBranch:  response.defaultBranch });
	}

	public changeBranch = async (branch: string): Promise<void> => {
		this.postMessage({ command: 'pr.changeBaseBranch', args: branch });
	}

	public changeCompareBranch = async (branch: string): Promise<void> => {
		this.postMessage({ command: 'pr.changeCompareBranch', args: branch });
	}


	private validate = () => {
		let isValid = true;
		if (!this.createParams.pendingTitle) {
			this.updateState({ showTitleValidationError: true });
			isValid = false;
		}

		if (!this.createParams.pendingDescription) {
			this.updateState({ showDescriptionValidationError: true });
			isValid = false;
		}

		this.updateState({ validate: true, createError: undefined });

		return isValid;
	}

	public submit = async (): Promise<void> => {
		if (!this.validate()) {
			return;
		}

		try {
			await this.postMessage({
				command: 'pr.create',
				args: {
					title: this.createParams.pendingTitle,
					body: this.createParams.pendingDescription,
					owner: this.createParams.selectedRemote.owner,
					repo: this.createParams.selectedRemote.repositoryName,
					base: this.createParams.selectedBranch
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

				if (this.createParams.selectedRemote === undefined) {
					message.params.selectedRemote = message.params.defaultRemote;
				} else {
					// Notify the extension of the stored selected remote state
					this.changeRemote(this.createParams.selectedRemote.owner, this.createParams.selectedRemote.repositoryName);
				}

				if (this.createParams.selectedBranch === undefined) {
					message.params.selectedBranch = message.params.defaultBranch;
				} else {
					// Notify the extension of the stored selected branch state
					this.changeBranch(this.createParams.selectedBranch);
				}

				if (this.createParams.compareBranch === undefined) {
					message.params.compareBranch = message.params.compareBranch;
				} else {
					// Notify the extension of the stored compare branch state
					this.changeCompareBranch(this.createParams.compareBranch);
				}

				this.updateState(message.params);
				return;
			case 'set-scroll':
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		}
	}

	public static instance = new CreatePRContext();
}

const PullRequestContext = createContext<CreatePRContext>(CreatePRContext.instance);
export default PullRequestContext;
