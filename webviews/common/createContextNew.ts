/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext } from 'react';
import { ChooseBaseRemoteAndBranchResult, ChooseCompareRemoteAndBranchResult, ChooseRemoteAndBranchArgs, CreateParamsNew, CreatePullRequestNew, RemoteInfo, ScrollPosition, TitleAndDescriptionArgs, TitleAndDescriptionResult } from '../../common/views';
import { getMessageHandler, MessageHandler, vscode } from './message';

const defaultCreateParams: CreateParamsNew = {
	defaultBaseRemote: undefined,
	defaultBaseBranch: undefined,
	defaultCompareRemote: undefined,
	defaultCompareBranch: undefined,
	validate: false,
	showTitleValidationError: false,
	labels: [],
	isDraftDefault: false,
	autoMergeDefault: false,
	assignees: [],
	reviewers: [],
	milestone: undefined,
	defaultTitle: undefined,
	pendingTitle: undefined,
	defaultDescription: undefined,
	pendingDescription: undefined,
	creating: false,
	generateTitleAndDescriptionTitle: undefined,
	initializeWithGeneratedTitleAndDescription: false,
	baseHasMergeQueue: false
};

export class CreatePRContextNew {
	public createParams: CreateParamsNew;
	private _titleStack: string[] = [];
	private _descriptionStack: string[] = [];

	constructor(
		public onchange: ((ctx: CreateParamsNew) => void) | null = null,
		private _handler: MessageHandler | null = null,
	) {
		this.createParams = vscode.getState() ?? defaultCreateParams;
		if (!_handler) {
			this._handler = getMessageHandler(this.handleMessage);
		}
	}

	get initialized(): boolean {
		if (this.createParams.defaultBaseRemote !== undefined
			|| this.createParams.defaultBaseBranch !== undefined
			|| this.createParams.defaultCompareRemote !== undefined
			|| this.createParams.defaultCompareBranch !== undefined
			|| this.createParams.validate
			|| this.createParams.showTitleValidationError) {
			return true;
		}

		return false;
	}

	private _requestedInitialize = false;
	public initialize = async (): Promise<void> => {
		if (!this._requestedInitialize) {
			this._requestedInitialize = true;
			this.postMessage({ command: 'pr.requestInitialize' });
		}
	};

	public cancelCreate = (): Promise<void> => {
		const args = this.copyParams();
		vscode.setState(defaultCreateParams);
		return this.postMessage({ command: 'pr.cancelCreate', args });
	};

	public updateState = (params: Partial<CreateParamsNew>, reset: boolean = false): void => {
		this.createParams = reset ? { ...defaultCreateParams, ...params } : { ...this.createParams, ...params };
		vscode.setState(this.createParams);
		if (this.onchange) {
			this.onchange(this.createParams);
		}
	};

	public changeBaseRemoteAndBranch = async (currentRemote?: RemoteInfo, currentBranch?: string): Promise<void> => {
		const args: ChooseRemoteAndBranchArgs = {
			currentRemote,
			currentBranch
		};
		const response: ChooseBaseRemoteAndBranchResult = await this.postMessage({
			command: 'pr.changeBaseRemoteAndBranch',
			args
		});

		const updateValues: Partial<CreateParamsNew> = {
			baseRemote: response.baseRemote,
			baseBranch: response.baseBranch,
			createError: ''
		};
		if ((this.createParams.baseRemote?.owner !== response.baseRemote.owner) || (this.createParams.baseRemote.repositoryName !== response.baseRemote.repositoryName)) {
			updateValues.defaultMergeMethod = response.defaultMergeMethod;
			updateValues.allowAutoMerge = response.allowAutoMerge;
			updateValues.mergeMethodsAvailability = response.mergeMethodsAvailability;
			updateValues.autoMergeDefault = response.autoMergeDefault;
			updateValues.baseHasMergeQueue = response.baseHasMergeQueue;
			if (!this.createParams.allowAutoMerge && updateValues.allowAutoMerge) {
				updateValues.autoMerge = this.createParams.isDraft ? false : updateValues.autoMergeDefault;
			}
			updateValues.defaultTitle = response.defaultTitle;
			if ((this.createParams.pendingTitle === undefined) || (this.createParams.pendingTitle === this.createParams.defaultTitle)) {
				updateValues.pendingTitle = response.defaultTitle;
			}
			updateValues.defaultDescription = response.defaultDescription;
			if ((this.createParams.pendingDescription === undefined) || (this.createParams.pendingDescription === this.createParams.defaultDescription)) {
				updateValues.pendingDescription = response.defaultDescription;
			}
		}

		this.updateState(updateValues);
	};

	public changeMergeRemoteAndBranch = async (currentRemote?: RemoteInfo, currentBranch?: string): Promise<void> => {
		const args: ChooseRemoteAndBranchArgs = {
			currentRemote,
			currentBranch
		};
		const response: ChooseCompareRemoteAndBranchResult = await this.postMessage({
			command: 'pr.changeCompareRemoteAndBranch',
			args
		});

		const updateValues: Partial<CreateParamsNew> = {
			compareRemote: response.compareRemote,
			compareBranch: response.compareBranch,
			createError: ''
		};

		this.updateState(updateValues);
	};

	public generateTitle = async (useCopilot: boolean): Promise<void> => {
		const args: TitleAndDescriptionArgs = {
			useCopilot
		};
		const response: TitleAndDescriptionResult = await this.postMessage({
			command: 'pr.generateTitleAndDescription',
			args
		});
		const updateValues: { pendingTitle?: string, pendingDescription?: string } = {};
		if (response.title) {
			updateValues.pendingTitle = response.title;
		}
		if (response.description) {
			updateValues.pendingDescription = response.description;
		}
		if (updateValues.pendingTitle && this.createParams.pendingTitle && this.createParams.pendingTitle !== updateValues.pendingTitle) {
			this._titleStack.push(this.createParams.pendingTitle);
		}
		if (updateValues.pendingDescription && this.createParams.pendingDescription && this.createParams.pendingDescription !== updateValues.pendingDescription) {
			this._descriptionStack.push(this.createParams.pendingDescription);
		}
		this.updateState(updateValues);
	};

	public cancelGenerateTitle = async (): Promise<void> => {
		return this.postMessage({
			command: 'pr.cancelGenerateTitleAndDescription'
		});
	};

	public popTitle = (): void => {
		if (this._titleStack.length > 0) {
			this.updateState({ pendingTitle: this._titleStack.pop() });
		}
	};

	public popDescription = (): void => {
		if (this._descriptionStack.length > 0) {
			this.updateState({ pendingDescription: this._descriptionStack.pop() });
		}
	}

	public validate = (): boolean => {
		let isValid = true;
		if (!this.createParams.pendingTitle) {
			this.updateState({ showTitleValidationError: true });
			isValid = false;
		}

		this.updateState({ validate: true, createError: undefined });

		return isValid;
	};

	private copyParams(): CreatePullRequestNew {
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
			labels: this.createParams.labels ?? [],
			projects: this.createParams.projects ?? [],
			assignees: this.createParams.assignees ?? [],
			reviewers: this.createParams.reviewers ?? [],
			milestone: this.createParams.milestone
		};
	}

	public submit = async (): Promise<void> => {
		try {
			this.updateState({ creating: false });
			const args: CreatePullRequestNew = this.copyParams();
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

	handleMessage = async (message: { command: string, params?: Partial<CreateParamsNew>, scrollPosition?: ScrollPosition }): Promise<void> => {
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
				}

				if (this.createParams.baseBranch === undefined) {
					message.params.baseBranch = message.params.defaultBaseBranch;
				}

				if (this.createParams.compareRemote === undefined) {
					message.params.compareRemote = message.params.defaultCompareRemote;
				}

				if (this.createParams.compareBranch === undefined) {
					message.params.compareBranch = message.params.defaultCompareBranch;
				}

				if (this.createParams.isDraft === undefined) {
					message.params.isDraft = message.params.isDraftDefault;
				} else {
					message.params.isDraft = this.createParams.isDraft;
				}

				if (this.createParams.autoMerge === undefined) {
					message.params.autoMerge = message.params.autoMergeDefault;
					message.params.autoMergeMethod = message.params.defaultMergeMethod;
					if (message.params.autoMerge) {
						message.params.isDraft = false;
					}
				} else {
					message.params.autoMerge = this.createParams.autoMerge;
					message.params.autoMergeMethod = this.createParams.autoMergeMethod;
				}

				this.updateState(message.params);
				return;

			case 'reset':
				if (!message.params) {
					this.updateState(defaultCreateParams, true);
					return;
				}
				message.params.pendingTitle = message.params.defaultTitle ?? this.createParams.pendingTitle;
				message.params.pendingDescription = message.params.defaultDescription ?? this.createParams.pendingDescription;
				message.params.baseRemote = message.params.defaultBaseRemote ?? this.createParams.baseRemote;
				message.params.baseBranch = message.params.defaultBaseBranch ?? this.createParams.baseBranch;
				message.params.compareBranch = message.params.defaultCompareBranch ?? this.createParams.compareBranch;
				message.params.compareRemote = message.params.defaultCompareRemote ?? this.createParams.compareRemote;
				message.params.autoMerge = (message.params.autoMergeDefault !== undefined ? message.params.autoMergeDefault : this.createParams.autoMerge);
				message.params.autoMergeMethod = (message.params.defaultMergeMethod !== undefined ? message.params.defaultMergeMethod : this.createParams.autoMergeMethod);
				message.params.isDraft = (message.params.isDraftDefault !== undefined ? message.params.isDraftDefault : this.createParams.isDraft);
				if (message.params.autoMergeDefault) {
					message.params.isDraft = false;
				}
				this.updateState(message.params);
				return;

			case 'set-scroll':
				if (!message.scrollPosition) {
					return;
				}
				window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
				return;

			case 'set-labels':
			case 'set-assignees':
			case 'set-reviewers':
			case 'set-projects':
				if (!message.params) {
					return;
				}
				this.updateState(message.params);
				return;
			case 'set-milestone':
				if (!message.params) {
					return;
				}
				this.updateState(Object.keys(message.params).length === 0 ? { milestone: undefined } : message.params);
				return;
			case 'create':
				if (!message.params) {
					return;
				}
				this.updateState(message.params);
				return;
		}
	};

	public static instance = new CreatePRContextNew();
}

const PullRequestContextNew = createContext<CreatePRContextNew>(CreatePRContextNew.instance);
export default PullRequestContextNew;
