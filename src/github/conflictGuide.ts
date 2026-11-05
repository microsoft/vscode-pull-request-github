/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Change, Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import { asPromise, formatError } from '../common/utils';

type ConflictOperation =
	| { readonly kind: 'merge'; readonly message: string; readonly push: boolean }
	/** `subject` names what the rebase is updating, such as a pull request, so the user knows what they are resolving. */
	| { readonly kind: 'rebase'; readonly subject?: string };

export class ConflictModel extends Disposable {
	public readonly startingConflictsCount: number;
	private _lastReportedRemainingCount: number;
	private _onConflictCountChanged: vscode.EventEmitter<number> = new vscode.EventEmitter();
	public readonly onConflictCountChanged: vscode.Event<number> = this._onConflictCountChanged.event; // reports difference in number of conflicts
	private _finishedCommit: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	private _isFinished = false;
	private _finishedResult = false;
	private _isAborting = false;

	private constructor(private readonly _repository: Repository, public readonly operation: ConflictOperation) {
		super();
		this.startingConflictsCount = this.remainingConflicts.length;
		this._lastReportedRemainingCount = this.startingConflictsCount;
		if (operation.kind === 'merge') {
			this._repository.inputBox.value = operation.message;
		} else {
			this._watchForRebaseToMovePastStop();
		}
		this._watchForRemainingConflictsChange();
	}

	/**
	 * Rebases stop once per conflicting commit. This guide is finished as soon as the rebase leaves the stop
	 * it started at: by continuing to another stop, completing, or being aborted outside of the guide.
	 */
	private _watchForRebaseToMovePastStop() {
		const stoppedAt = this._repository.state.rebaseCommit?.hash;
		const listener = this._register(this._repository.state.onDidChange(() => {
			if (!this._isAborting && this._repository.state.rebaseCommit?.hash !== stoppedAt) {
				listener.dispose();
				this._finish(true);
			}
		}));
	}

	private _finish(result: boolean) {
		if (!this._isFinished) {
			this._isFinished = true;
			this._finishedResult = result;
			this._finishedCommit.fire(result);
		}
	}

	get isFinished(): boolean {
		return this._isFinished;
	}

	private _watchForRemainingConflictsChange() {
		this._register(vscode.window.tabGroups.onDidChangeTabs(async (e) => {
			if (e.closed.length > 0) {
				await this._repository.status();
				this._reportProgress();
			}
		}));
		this._register(this._repository.state.onDidChange(async () => {
			this._reportProgress();
		}));
	}

	private _reportProgress() {
		if (this._lastReportedRemainingCount === 0 || this._isAborting) {
			// Already done, or the conflicts are going away because the operation is being aborted.
			return;
		}
		const remainingCount = this.remainingConflicts.length;
		if (this._lastReportedRemainingCount !== remainingCount) {
			this._onConflictCountChanged.fire(this._lastReportedRemainingCount - remainingCount);
			this._lastReportedRemainingCount = remainingCount;
		}
		if (this._lastReportedRemainingCount === 0 && this.operation.kind === 'merge') {
			this.listenForCommit();
		}
	}

	private async listenForCommit() {
		let localDisposable: vscode.Disposable | undefined;
		const result = await new Promise<boolean>(resolve => {
			const startingCommit = this._repository.state.HEAD?.commit;
			localDisposable = this._register(this._repository.state.onDidChange(() => {
				if (this._repository.state.HEAD?.commit !== startingCommit && this._repository.state.indexChanges.length === 0 && this._repository.state.mergeChanges.length === 0) {
					resolve(true);
				}
			}));
		});

		localDisposable?.dispose();
		if (result && this.operation.kind === 'merge' && this.operation.push) {
			this._repository.push();
		}
		this._finish(result);
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
		this._isAborting = true;
		if (this.operation.kind === 'merge') {
			this._repository.inputBox.value = '';
		}
		// set up an event to listen for when we are all out of merge changes before closing the merge editors.
		// Just waiting for the merge doesn't cut it
		// Even with this, we still need to wait 1 second, and then it still might say there are conflicts. Why is this?
		const disposable = this._register(this._repository.state.onDidChange(async () => {
			if (this._repository.state.mergeChanges.length === 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 1000));
				this.closeMergeEditors();
				disposable.dispose();
			}
		}));
		try {
			await (this.operation.kind === 'merge' ? this._repository.mergeAbort() : this._repository.rebaseAbort!());
		} finally {
			this._finish(false);
		}
	}

	/**
	 * Concludes the operation once all conflicts are resolved: commits the merge or continues the rebase.
	 */
	public async conclude(): Promise<void> {
		if (this.operation.kind === 'merge') {
			return this._repository.commit(this.operation.message);
		}
		try {
			await this._repository.rebaseContinue!();
		} catch (error) {
			// Continuing can stop at the next conflicting commit, which still moves the rebase past this stop.
			await this._repository.status();
			if (!this._isFinished) {
				throw error;
			}
		}
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
		return ConflictModel._begin(repository, { kind: 'merge', message: `Merge branch '${upstream}' into ${into}`, push });
	}

	/**
	 * Guides the user through the conflicts of a rebase that stopped at a conflicting commit.
	 * The repository must support `rebaseContinue` and `rebaseAbort`.
	 */
	public static async beginRebase(repository: Repository, subject?: string): Promise<ConflictModel | undefined> {
		return ConflictModel._begin(repository, { kind: 'rebase', subject });
	}

	private static async _begin(repository: Repository, operation: ConflictOperation): Promise<ConflictModel | undefined> {
		const model = new ConflictModel(repository, operation);
		if (model.remainingConflicts.length === 0) {
			model.dispose();
			return undefined;
		}
		model._register(new ConflictNotification(model));
		model.first();
		return model;
	}

	public get onDidFinish(): vscode.Event<boolean> {
		return this._finishedCommit.event;
	}

	public finished(): Promise<boolean> {
		if (this._isFinished) {
			return Promise.resolve(this._finishedResult);
		}
		return asPromise(this._finishedCommit.event);
	}
}

/**
 * Guides the user through the conflicts at the current stop of a rebase and waits for the rebase to move past it.
 * `subject` names what the rebase is updating in the guide's notifications.
 * Resolves to `false` if the user aborted the rebase from the guide.
 */
export async function guideRebaseConflicts(repository: Repository, subject?: string): Promise<boolean> {
	const model = await ConflictModel.beginRebase(repository, subject);
	if (!model) {
		return true;
	}
	try {
		return await model.finished();
	} finally {
		model.dispose();
	}
}

class ConflictNotification extends Disposable {

	constructor(private readonly _conflictModel: ConflictModel) {
		super();
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
			const { operation } = this._conflictModel;
			const report = (increment: number) => {
				const remaining = this._conflictModel.remainingConflicts.length;
				const total = this._conflictModel.startingConflictsCount;
				progress.report({
					message: operation.kind === 'rebase' && operation.subject
						? vscode.l10n.t('Resolve the conflicts in {0} using the Source Control view, {1} of {2} remaining', operation.subject, remaining, total)
						: vscode.l10n.t('Use the Source Control view to resolve conflicts, {0} of {1} remaining', remaining, total),
					increment,
				});
			};
			report(0);
			return new Promise<boolean>((resolve) => {
				this._register(this._conflictModel.onConflictCountChanged((conflictsChangedBy) => {
					const increment = conflictsChangedBy * (100 / this._conflictModel.startingConflictsCount);
					report(increment);
					if (this._conflictModel.remainingConflicts.length === 0) {
						resolve(true);
					}
				}));
				this._register(this._conflictModel.onDidFinish(() => resolve(false)));
				this._register(token.onCancellationRequested(() => {
					this._conflictModel.abort();
					resolve(false);
				}));
			});
		}).then(async (result) => {
			if (!result || this._conflictModel.isFinished) {
				return;
			}
			const { operation } = this._conflictModel;
			let message: string;
			let conclude: string;
			let cancel: string;
			if (operation.kind === 'rebase') {
				message = operation.subject
					? vscode.l10n.t('All conflicts in {0} resolved. Continue the rebase to proceed.', operation.subject)
					: vscode.l10n.t('All conflicts resolved. Continue the rebase to proceed.');
				conclude = vscode.l10n.t('Continue Rebase');
				cancel = vscode.l10n.t('Abort Rebase');
			} else {
				message = operation.push
					? vscode.l10n.t('All conflicts resolved. Commit and push the resolution to continue.')
					: vscode.l10n.t('All conflicts resolved. Commit the resolution to continue.');
				conclude = vscode.l10n.t('Commit');
				cancel = vscode.l10n.t('Abort Merge');
			}
			const choice = await vscode.window.showInformationMessage(message, conclude, cancel);
			// The operation can also be concluded or aborted from the Source Control view while the message is shown.
			if (this._conflictModel.isFinished) {
				return;
			}
			try {
				if (choice === conclude) {
					await this._conflictModel.conclude();
				} else if (choice === cancel) {
					await this._conflictModel.abort();
				}
			} catch (error) {
				vscode.window.showErrorMessage(operation.kind === 'rebase'
					? vscode.l10n.t('Unable to continue the rebase: {0}', formatError(error))
					: vscode.l10n.t('Unable to commit the merge: {0}', formatError(error)));
			}
		});
	}
}
