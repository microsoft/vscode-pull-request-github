/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Change, Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import { asPromise, dispose } from '../common/utils';

export class ConflictModel implements vscode.Disposable {
	public readonly startingConflictsCount: number;
	private _lastReportedRemainingCount: number;
	private _disposables: vscode.Disposable[] = [];
	private _onConflictCountChanged: vscode.EventEmitter<number> = new vscode.EventEmitter();
	public readonly onConflictCountChanged: vscode.Event<number> = this._onConflictCountChanged.event; // reports difference in number of conflicts
	private _finishedCommit: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	public readonly message: string;

	constructor(private readonly _repository: Repository, private readonly _upstream: string, private readonly _into: string, public readonly push: boolean) {
		this.startingConflictsCount = this.remainingConflicts.length;
		this._lastReportedRemainingCount = this.startingConflictsCount;
		this._repository.inputBox.value = this.message = `Merge branch '${this._upstream}' into ${this._into}`;
		this._watchForRemainingConflictsChange();
	}

	private _watchForRemainingConflictsChange() {
		this._disposables.push(vscode.window.tabGroups.onDidChangeTabs(async (e) => {
			if (e.closed.length > 0) {
				await this._repository.status();
				this._reportProgress();
			}
		}));
		this._disposables.push(this._repository.state.onDidChange(async () => {
			this._reportProgress();
		}));
	}

	private _reportProgress() {
		if (this._lastReportedRemainingCount === 0) {
			// Already done.
			return;
		}
		const remainingCount = this.remainingConflicts.length;
		if (this._lastReportedRemainingCount !== remainingCount) {
			this._onConflictCountChanged.fire(this._lastReportedRemainingCount - remainingCount);
			this._lastReportedRemainingCount = remainingCount;
		}
		if (this._lastReportedRemainingCount === 0) {
			this.listenForCommit();
		}
	}

	private async listenForCommit() {
		let localDisposable: vscode.Disposable | undefined;
		const result = await new Promise<boolean>(resolve => {
			const startingCommit = this._repository.state.HEAD?.commit;
			localDisposable = this._repository.state.onDidChange(() => {
				if (this._repository.state.HEAD?.commit !== startingCommit && this._repository.state.indexChanges.length === 0 && this._repository.state.mergeChanges.length === 0) {
					resolve(true);
				}
			});
			this._disposables.push(localDisposable);
		});

		localDisposable?.dispose();
		if (result && this.push) {
			this._repository.push();
		}
		this._finishedCommit.fire(result);
	}

	get remainingConflicts(): Change[] {
		return this._repository.state.mergeChanges;
	}

	private async closeMergeEditors(): Promise<void> {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputTextMerge) {
					vscode.window.tabGroups.close(tab);
				}
			}
		}
	}

	public async abort(): Promise<void> {
		this._repository.inputBox.value = '';
		// set up an event to listen for when we are all out of merge changes before closing the merge editors.
		// Just waiting for the merge doesn't cut it
		// Even with this, we still need to wait 1 second, and then it still might say there are conflicts. Why is this?
		const disposable = this._repository.state.onDidChange(async () => {
			if (this._repository.state.mergeChanges.length === 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 1000));
				this.closeMergeEditors();
				disposable.dispose();
			}
		});
		this._disposables.push(disposable);
		await this._repository.mergeAbort();
		this._finishedCommit.fire(false);
	}

	private async first(): Promise<void> {
		if (this.remainingConflicts.length === 0) {
			return;
		}
		await commands.focusView('workbench.scm');
		this._reportProgress();
		await Promise.all(this.remainingConflicts.map(conflict => commands.executeCommand('git.openMergeEditor', conflict.uri)));
	}

	public static async begin(repository: Repository, upstream: string, into: string, push: boolean): Promise<ConflictModel | undefined> {
		const model = new ConflictModel(repository, upstream, into, push);
		if (model.remainingConflicts.length === 0) {
			return undefined;
		}
		const notification = new ConflictNotification(model, repository);
		model._disposables.push(notification);
		model.first();
		return model;
	}

	public finished(): Promise<boolean> {
		return asPromise(this._finishedCommit.event);
	}

	dispose() {
		dispose(this._disposables);
	}
}

class ConflictNotification implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];

	constructor(private readonly _conflictModel: ConflictModel, private readonly _repository: Repository) {
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
			const report = (increment: number) => {
				progress.report({ message: vscode.l10n.t('Use the Source Control view to resolve conflicts, {0} of {0} remaining', this._conflictModel.remainingConflicts.length, this._conflictModel.startingConflictsCount), increment });
			};
			report(0);
			return new Promise<boolean>((resolve) => {
				this._disposables.push(this._conflictModel.onConflictCountChanged((conflictsChangedBy) => {
					const increment = conflictsChangedBy * (100 / this._conflictModel.startingConflictsCount);
					report(increment);
					if (this._conflictModel.remainingConflicts.length === 0) {
						resolve(true);
					}
				}));
				this._disposables.push(token.onCancellationRequested(() => {
					this._conflictModel.abort();
					resolve(false);
				}));
			});
		}).then(async (result) => {
			if (result) {
				const commit = vscode.l10n.t('Commit');
				const cancel = vscode.l10n.t('Abort Merge');
				let message: string;
				if (this._conflictModel.push) {
					message = vscode.l10n.t('All conflicts resolved. Commit and push the resolution to continue.');
				} else {
					message = vscode.l10n.t('All conflicts resolved. Commit the resolution to continue.');
				}
				const result = await vscode.window.showInformationMessage(message, commit, cancel);
				if (result === commit) {
					await this._repository.commit(this._conflictModel.message);
				} else if (result === cancel) {
					await this._conflictModel.abort();
				}
			}
		});
	}

	dispose() {
		dispose(this._disposables);
	}
}