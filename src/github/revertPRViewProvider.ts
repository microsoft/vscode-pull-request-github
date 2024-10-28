/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CreateParamsNew, CreatePullRequestNew } from '../../common/views';
import { openDescription } from '../commands';
import { commands, contexts } from '../common/executeCommands';
import { ITelemetry } from '../common/telemetry';
import { IRequestMessage } from '../common/webview';
import { BaseCreatePullRequestViewProvider, BasePullRequestDataModel } from './createPRViewProvider';
import {
	FolderRepositoryManager,
	PullRequestDefaults,
} from './folderRepositoryManager';
import { BaseBranchMetadata } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';

export class RevertPullRequestViewProvider extends BaseCreatePullRequestViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	constructor(
		telemetry: ITelemetry,
		model: BasePullRequestDataModel,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		pullRequestDefaults: PullRequestDefaults,
		private readonly pullRequest: PullRequestModel
	) {
		super(telemetry, model, extensionUri, folderRepositoryManager, pullRequestDefaults, folderRepositoryManager.repository.state.HEAD?.name ?? pullRequest.base.name);
	}

	protected async getTitleAndDescription(): Promise<{ title: string; description: string; }> {
		return {
			title: vscode.l10n.t('Revert "{0}"', this.pullRequest.title),
			description: vscode.l10n.t('Reverts {0}', `${this.pullRequest.remote.owner}/${this.pullRequest.remote.repositoryName}#${this.pullRequest.number}`)
		};
	}

	protected async detectBaseMetadata(): Promise<BaseBranchMetadata | undefined> {
		return {
			owner: this.pullRequest.remote.owner,
			repositoryName: this.pullRequest.remote.repositoryName,
			branch: this.pullRequest.base.name
		};
	}

	protected getTitleAndDescriptionProvider(_name?: string) {
		return undefined;
	}

	protected async getCreateParams(): Promise<CreateParamsNew> {
		const params = await super.getCreateParams();
		params.canModifyBranches = false;
		params.actionDetail = vscode.l10n.t('Reverting');
		params.associatedExistingPullRequest = this.pullRequest.number;
		return params;
	}

	private openAssociatedPullRequest() {
		return openDescription(this.telemetry, this.pullRequest, undefined, this._folderRepositoryManager, false, true);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'pr.openAssociatedPullRequest':
				return this.openAssociatedPullRequest();
			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}

	protected async create(message: IRequestMessage<CreatePullRequestNew>): Promise<void> {
		let revertPr: PullRequestModel | undefined;
		RevertPullRequestViewProvider.withProgress(async () => {
			commands.setContext(contexts.CREATING, true);
			try {
				revertPr = await this._folderRepositoryManager.revert(this.pullRequest, message.args.title, message.args.body, message.args.draft);
				if (revertPr) {
					await this.postCreate(message, revertPr);
					await openDescription(this.telemetry, revertPr, undefined, this._folderRepositoryManager, true);
				}

			} catch (e) {
				if (!revertPr) {
					let errorMessage: string = e.message;
					if (errorMessage.startsWith('GraphQL error: ')) {
						errorMessage = errorMessage.substring('GraphQL error: '.length);
					}
					this._throwError(message, errorMessage);
				} else {
					if ((e as Error).message === 'GraphQL error: ["Pull request Pull request is in unstable status"]') {
						// This error can happen if the PR isn't fully created by the time we try to set properties on it. Try again.
						await this.postCreate(message, revertPr);
					}
					// All of these errors occur after the PR is created, so the error is not critical.
					vscode.window.showErrorMessage(vscode.l10n.t('There was an error creating the pull request: {0}', (e as Error).message));
				}
			} finally {
				commands.setContext(contexts.CREATING, false);
				if (revertPr) {
					this._onDone.fire(revertPr);
				} else {
					await this._replyMessage(message, {});
				}
			}
		});
	}
}