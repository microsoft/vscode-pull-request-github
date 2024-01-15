/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Change, Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import { asPromise, dispose } from '../common/utils';

export class ConflictGuide implements vscode.Disposable {
	private _progress: vscode.Progress<{ message?: string; increment?: number }> | undefined;
	private readonly _startingConflictsCount: number;
	private readonly _oneProgressIncrement: number;
	private _lastReportedRemainingCount: number;
	private _disposables: vscode.Disposable[] = [];
	private _finishedCommit: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	private _finishedConflicts: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	private _message: string;

	constructor(private readonly _repository: Repository, private readonly _upstream: string, private readonly _into: string) {
		this._startingConflictsCount = this.remainingConflicts.length;
		this._lastReportedRemainingCount = this._startingConflictsCount;
		this._oneProgressIncrement = 100 / this._startingConflictsCount;
		this._repository.inputBox.value = this._message = `Merge branch '${this._upstream}' into ${this._into}`;
		this._watchForRemainingConflictsChange();
	}

	private _watchForRemainingConflictsChange() {
		this._disposables.push(vscode.window.tabGroups.onDidChangeTabs(async (e) => {
			if (e.closed.length > 0) {
				await this._repository.status();
				this._reportProgress();
			}
		}));
	}

	private _reportProgress() {
		const remainingCount = this.remainingConflicts.length;
		if (this._progress) {
			const increment = (this._lastReportedRemainingCount - remainingCount) * this._oneProgressIncrement;
			this._progress.report({ message: vscode.l10n.t('Use the Source Control view to resolve conflicts, {0} of {0} remaining', remainingCount, this._startingConflictsCount), increment });
			this._lastReportedRemainingCount = remainingCount;
		}
		if (remainingCount === 0) {
			this._finishedConflicts.fire(true);
			this.commit();
		}
	}

	private async commitFromNotification(): Promise<boolean> {
		const commit = vscode.l10n.t('Commit');
		const cancel = vscode.l10n.t('Abort Merge');
		const result = await vscode.window.showInformationMessage(vscode.l10n.t('All conflicts resolved. Commit and push the resolution to continue.'), commit, cancel);
		if (result === commit) {
			await this._repository.commit(this._message);
			this._repository.inputBox.value = '';
			await this._repository.push();
			return true;
		} else {
			await this.abort();
			return false;
		}
	}

	private async commit() {
		let localDisposable: vscode.Disposable | undefined;
		const scmCommit = new Promise<boolean>(resolve => {
			const startingCommit = this._repository.state.HEAD?.commit;
			localDisposable = this._repository.state.onDidChange(() => {
				if (this._repository.state.HEAD?.commit !== startingCommit && this._repository.state.indexChanges.length === 0 && this._repository.state.mergeChanges.length === 0) {
					resolve(true);
				}
			});
			this._disposables.push(localDisposable);
		});

		const notificationCommit = this.commitFromNotification();

		const result = await Promise.race([scmCommit, notificationCommit]);
		localDisposable?.dispose();
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

	private async abort(): Promise<void> {
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
		await this._repository.mergeAbort();
		this._finishedCommit.fire(false);
	}

	private async first(progress: vscode.Progress<{ message?: string; increment?: number }>, cancellationToken: vscode.CancellationToken): Promise<void> {
		this._progress = progress;
		if (this.remainingConflicts.length === 0) {
			return;
		}
		await commands.focusView('workbench.scm');
		this._reportProgress();
		const change = this.remainingConflicts[0];
		this._disposables.push(cancellationToken.onCancellationRequested(() => this.abort()));
		await commands.executeCommand('git.openMergeEditor', change.uri);
	}

	public static async begin(repository: Repository, upstream: string, into: string): Promise<ConflictGuide | undefined> {
		const wizard = new ConflictGuide(repository, upstream, into);
		if (wizard.remainingConflicts.length === 0) {
			return undefined;
		}
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
			wizard.first(progress, token);
			return wizard.finishedConflicts();
		});
		return wizard;
	}

	private finishedConflicts(): Promise<boolean> {
		return asPromise(this._finishedConflicts.event);
	}

	public finished(): Promise<boolean> {
		return asPromise(this._finishedCommit.event);
	}

	dispose() {
		dispose(this._disposables);
	}
}