import { JsonPatchDocument, JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import {
	AccountRecentActivityWorkItemModel2,
	WorkItem,
	WorkItemExpand,
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { IWorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import * as vscode from 'vscode';
import { PullRequestModel } from '../azdo/pullRequestModel';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { Azdo, CredentialStore } from './credentials';

export class AzdoWorkItem implements vscode.Disposable {
	static ID = 'WorkItem';
	private _toDispose: vscode.Disposable[] = [];
	private _hub: Azdo | undefined;
	private _workTracking?: IWorkItemTrackingApi;

	constructor(private readonly _credentialStore: CredentialStore, private readonly _telemetry: ITelemetry) {}

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
			const res = await this._workTracking?.getWorkItem(id, undefined, undefined, WorkItemExpand.All);
			Logger.appendLine(`Fetching workitem for id: ${id} - finished`, AzdoWorkItem.ID);
			return res;
		} catch (error) {
			Logger.appendLine(`Fetching workitem for id: ${id} - failed. Error: ${error.message}`, AzdoWorkItem.ID);
		}
	}

	public async getRecentWorkItems(): Promise<AccountRecentActivityWorkItemModel2[]> {
		try {
			Logger.appendLine(`Fetching recent workitem - started`, AzdoWorkItem.ID);
			const result = (await this._workTracking?.getRecentActivityData()) ?? [];
			Logger.appendLine(`Fetching recent workitem - finished`, AzdoWorkItem.ID);
			return result;
		} catch (error) {
			Logger.appendLine(`Fetching recent workitem - failed. Error: ${error.message}`, AzdoWorkItem.ID);
			return [];
		}
	}

	public async associateWorkItemWithPR(workItemId: number, pr: PullRequestModel): Promise<WorkItem | undefined> {
		try {
			Logger.appendLine(
				`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - started`,
				AzdoWorkItem.ID,
			);
			this._telemetry.sendTelemetryEvent('wt.associate');

			const po: JsonPatchOperation = {
				op: Operation.Add,
				path: '/relations/-',
				value: {
					rel: 'ArtifactLink',
					url: pr.item.artifactId,
					attributes: {
						name: 'pull request',
					},
				},
			};

			const doc: JsonPatchDocument = [po];

			const res = await this._workTracking?.updateWorkItem({}, doc, workItemId);

			Logger.appendLine(
				`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - finished`,
				AzdoWorkItem.ID,
			);
			return res;
		} catch (error) {
			Logger.appendLine(
				`Associating work item: ${workItemId} with PR ${pr.getPullRequestId()} - failed. Error: ${error.message}`,
				AzdoWorkItem.ID,
			);
			vscode.window.showWarningMessage(`Unable to associate workitem. Error: ${error.message}`);
		}
	}

	public async disassociateWorkItemWithPR(workItem: WorkItem, pr: PullRequestModel): Promise<WorkItem | undefined> {
		try {
			Logger.appendLine(
				`Removing work item: ${workItem.id} link with PR ${pr.getPullRequestId()} - started`,
				AzdoWorkItem.ID,
			);
			this._telemetry.sendTelemetryEvent('wt.disassociate');

			// Get relation index
			const idx = workItem.relations?.findIndex(
				w => w.rel === 'ArtifactLink' && w.url?.toUpperCase() === pr.item.artifactId?.toUpperCase(),
			);

			const po: JsonPatchOperation = {
				op: Operation.Remove,
				path: `/relations/${idx}`,
			};

			const doc: JsonPatchDocument = [po];

			const res = await this._workTracking?.updateWorkItem({}, doc, workItem.id!);
			Logger.appendLine(
				`Removing work item: ${workItem.id} link with PR ${pr.getPullRequestId()} - finished`,
				AzdoWorkItem.ID,
			);
			return res;
		} catch (error) {
			Logger.appendLine(
				`Removing work item: ${workItem.id} with PR ${pr.getPullRequestId()} - failed. Error: ${error.message}`,
				AzdoWorkItem.ID,
			);
			throw error;
		}
	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}
}
