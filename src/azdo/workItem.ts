import { IWorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { Azdo, CredentialStore } from './credentials';
import Logger from '../common/logger';
import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';

export class AzdoWorkItem implements vscode.Disposable {
	static ID = 'WorkItem';
	private _toDispose: vscode.Disposable[] = [];
	private _hub: Azdo | undefined;
	private _workTracking?: IWorkItemTrackingApi;

	constructor(private readonly _credentialStore: CredentialStore, private readonly _telemetry: ITelemetry) {
	}

	async ensure(): Promise<AzdoWorkItem> {

		if (!this._credentialStore.isAuthenticated()) {
			await this._credentialStore.initialize();
		}
		this._hub = this._credentialStore.getHub();
		this._workTracking = await this._hub?.connection.getWorkItemTrackingApi();

		return this;
	}
	public async getWorkItemById(id: number): Promise<WorkItem | undefined> {
		try {
			Logger.appendLine(`Fetching workitem for id: ${id} - started`, AzdoWorkItem.ID);
			const res = await this._workTracking?.getWorkItem(id);
			Logger.appendLine(`Fetching workitem for id: ${id} - finished`, AzdoWorkItem.ID);
			return res;

		} catch (error) {
			Logger.appendLine(`Fetching workitem for id: ${id} - failed. Error: ${error.message}`, AzdoWorkItem.ID);
		}
	}

	public async associateWorkItemWithPR(workItemId: number, pr: PullRequestModel): Promise<WorkItem | undefined> {
		try {
			Logger.appendLine(`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - started`, AzdoWorkItem.ID);
			this._telemetry.sendTelemetryEvent("wt.associate");

			const po: JsonPatchOperation = {
				op: Operation.Add,
				path: '/relations/-',
				value: {
					rel: 'ArtifactLink',
					url: pr.item.artifactId,
					attributes: {
						name: 'pull request'
					}
				}
			};

			const res = await this._workTracking?.updateWorkItem({}, po, pr.getPullRequestId());

			Logger.appendLine(`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - finished`, AzdoWorkItem.ID);
			return res;

		} catch (error) {
			Logger.appendLine(`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - failed. Error: ${error.message}`, AzdoWorkItem.ID);
			vscode.window.showWarningMessage(`Unable to associate workitem. Error: ${error.message}`);
		}
	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}
}