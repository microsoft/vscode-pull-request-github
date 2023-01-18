/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext } from 'react';
import { CreateParams, CreatePullRequest, ScrollPosition } from '../../common/views';
import { getMessageHandler, MessageHandler, vscode } from './message';

const defaultCreateParams: CreateParams = {
	availableBaseRemotes: [],
	availableCompareRemotes: [],
	branchesForRemote: [],
	branchesForCompare: [],
	validate: false,
	showTitleValidationError: false,
	labels: []
};

export class CreatePRContext {
	public createParams: CreateParams;

	constructor(
		public onchange: ((ctx: CreateParams) => void) | null = null,
		private _handler: MessageHandler | null = null,
	) {
		this.createParams = vscode.getState() ?? defaultCreateParams;
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	get initialized(): boolean {
		if (this.createParams.availableBaseRemotes.length !== 0
			|| this.createParams.availableCompareRemotes.length !== 0
			|| this.createParams.branchesForRemote.length !== 0
			|| this.createParams.branchesForCompare.length !== 0
			|| this.createParams.validate
			|| this.createParams.showTitleValidationError) {
			return true;
		}

		return false;
	}

	public cancelCreate = (): Promise<void> => {
		const args = this.copyParams();
		vscode.setState(defaultCreateParams);
		return this.postMessage({ command: 'pr.cancelCreate', args });
	};

	public updateState = (params: Partial<CreateParams>): void => {
		this.createParams = { ...this.createParams, ...params };
		vscode.setState(this.createParams);
		if (this.onchange) {
			this.onchange(this.createParams);
		}
	};

	public changeBaseRemote = async (owner: string, repositoryName: string): Promise<void> => {
		const response = await this.postMessage({
			command: 'pr.changeBaseRemote',
			args: {
				owner,
				repositoryName,
			},
		});

		this.updateState({
			baseRemote: { owner, repositoryName },
			branchesForRemote: response.branches,
			baseBranch: response.defaultBranch,
		});
	};

	public changeBaseBranch = async (branch: string): Promise<void> => {
		const response: { title?: string, description?: string } = await this.postMessage({
			command: 'pr.changeBaseBranch',
			args: branch
		});

		const pendingTitle = ((this.createParams.pendingTitle === undefined) || (this.createParams.pendingTitle === this.createParams.defaultTitle))
			? response.title : this.createParams.pendingTitle;
		const pendingDescription = ((this.createParams.pendingDescription === undefined) || (this.createParams.pendingDescription === this.createParams.defaultDescription))
			? response.description : this.createParams.pendingDescription;

		this.updateState({
			pendingTitle,
			pendingDescription
		});
	};

	public changeCompareRemote = async (owner: string, repositoryName: string): Promise<void> => {
		const response = await this.postMessage({
			command: 'pr.changeCompareRemote',
			args: {
				owner,
				repositoryName,
			},
		});

		this.updateState({
			compareRemote: { owner, repositoryName },
			branchesForCompare: response.branches,
			compareBranch: response.defaultBranch,
		});
	};

	public changeCompareBranch = async (branch: string): Promise<void> => {
		return this.postMessage({ command: 'pr.changeCompareBranch', args: branch });
	};

	public validate = (): boolean => {
		let isValid = true;
		if (!this.createParams.pendingTitle) {
			this.updateState({ showTitleValidationError: true });
			isValid = false;
		}

		this.updateState({ validate: true, createError: undefined });

		return isValid;
	};

	private copyParams(): CreatePullRequest {
		return {
			title: this.createParams.pendingTitle!,
			body: this.createParams.pendingDescription!,
			owner: this.createParams.baseRemote!.owner,
			repo: this.createParams.baseRemote!.repositoryName,
			base: this.createParams.baseBranch!,
			compareBranch: this.createParams.compareBranch!,
			compareOwner: this.createParams.compareRemote!.owner,
			compareRepo: this.createParams.compareRemote!.repositoryName,
			draft: !!this.createParams.isDraft,
			autoMerge: !!this.createParams.autoMerge,
			autoMergeMethod: this.createParams.autoMergeMethod,
			labels: this.createParams.labels ?? []
		};
	}

	public submit = async (): Promise<void> => {
		try {
			const args: CreatePullRequest = this.copyParams();
			vscode.setState(defaultCreateParams);
			await this.postMessage({
				command: 'pr.create',
				args,
			});
		} catch (e) {
			this.updateState({ createError: (typeof e === 'string') ? e : (e.message ? e.message : 'An unknown error occurred.') });
		}
	};

	postMessage = async (message: any): Promise<any> => {
		return this._handler?.postMessage(message);
	};

	handleMessage = async (message: { command: string, params?: CreateParams, scrollPosition?: ScrollPosition }): Promise<void> => {
		switch (message.command) {
			case 'pr.initialize':
				if (!message.params) {
					return;
				}
				if (this.createParams.pendingTitle === undefined) {
					message.params.pendingTitle = message.params.defaultTitle;
				}

				if (this.createParams.pendingDescription === undefined) {
					message.params.pendingDescription = message.params.defaultDescription;
				}

				if (this.createParams.baseRemote === undefined) {
					message.params.baseRemote = message.params.defaultBaseRemote;
				} else {
					// Notify the extension of the stored selected remote state
					await this.changeBaseRemote(
						this.createParams.baseRemote.owner,
						this.createParams.baseRemote.repositoryName,
					);
				}

				if (this.createParams.baseBranch === undefined) {
					message.params.baseBranch = message.params.defaultBaseBranch;
				} else {
					// Notify the extension of the stored base branch state
					await this.changeBaseBranch(this.createParams.baseBranch);
				}

				if (this.createParams.compareRemote === undefined) {
					message.params.compareRemote = message.params.defaultCompareRemote;
				} else {
					// Notify the extension of the stored base branch state This is where master is getting set.
					await this.changeCompareRemote(
						this.createParams.compareRemote.owner,
						this.createParams.compareRemote.repositoryName
					);
				}

				if (this.createParams.compareBranch === undefined) {
					message.params.compareBranch = message.params.defaultCompareBranch;
				} else {
					// Notify the extension of the stored compare branch state
					await this.changeCompareBranch(this.createParams.compareBranch);
				}

				if (this.createParams.isDraft === undefined) {
					message.params.isDraft = false;
				}

				this.updateState(message.params);
				return;

			case 'reset':
				if (!message.params) {
					return;
				}
				message.params.pendingTitle = message.params.defaultTitle;
				message.params.pendingDescription = message.params.defaultDescription;
				message.params.baseRemote = message.params.defaultBaseRemote;
				message.params.baseBranch = message.params.defaultBaseBranch;
				message.params.compareBranch = message.params.defaultCompareBranch;
				message.params.compareRemote = message.params.defaultCompareRemote;
				message.params.autoMerge = false;
				this.updateState(message.params);
				return;

			case 'set-scroll':
				if (!message.scrollPosition) {
					return;
				}
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
				return;

			case 'set-labels':
				if (!message.params) {
					return;
				}
				this.updateState(message.params);
				return;
		}
	};

	public static instance = new CreatePRContext();
}

const PullRequestContext = createContext<CreatePRContext>(CreatePRContext.instance);
export default PullRequestContext;
