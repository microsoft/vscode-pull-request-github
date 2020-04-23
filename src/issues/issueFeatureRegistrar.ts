/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager, PullRequestDefaults } from '../github/pullRequestManager';
import * as vscode from 'vscode';
import { IssueHoverProvider } from './issueHoverProvider';
import { UserHoverProvider } from './userHoverProvider';
import { IssueTodoProvider } from './issueTodoProvider';
import { IssueCompletionProvider } from './issueCompletionProvider';
import { NewIssue, createGithubPermalink, USER_EXPRESSION, ISSUES_CONFIGURATION, QUERIES_CONFIGURATION, pushAndCreatePR } from './util';
import { UserCompletionProvider } from './userCompletionProvider';
import { StateManager } from './stateManager';
import { IssuesTreeData } from './issuesView';
import { IssueModel } from '../github/issueModel';
import { CurrentIssue } from './currentIssue';
import { ReviewManager } from '../view/reviewManager';
import { Repository, GitAPI } from '../typings/git';
import { Resource } from '../common/resources';
import { IssueFileSystemProvider } from './issueFile';

export class IssueFeatureRegistrar implements vscode.Disposable {
	private _stateManager: StateManager;
	private createIssueInfo: { document: vscode.TextDocument, newIssue: NewIssue | undefined, assignee: string | undefined, lineNumber: number | undefined, insertIndex: number | undefined } | undefined;

	constructor(gitAPI: GitAPI, private manager: PullRequestManager, private reviewManager: ReviewManager, private context: vscode.ExtensionContext) {
		this._stateManager = new StateManager(gitAPI, this.manager, this.reviewManager, this.context);
	}

	async initialize() {
		this.context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new IssueCompletionProvider(this._stateManager, this.manager, this.context), '#'));
		this.context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new UserCompletionProvider(this._stateManager, this.manager, this.context), '@'));
		await this._stateManager.tryInitializeAndWait();
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromSelection', this.createTodoIssue, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromClipboard', this.createTodoIssueClipboard, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.copyGithubPermalink', this.copyPermalink, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.openGithubPermalink', this.openPermalink, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.openIssue', this.openIssue));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.startWorking', this.startWorking, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.startWorkingBranchPrompt', this.startWorkingBranchPrompt, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.stopWorking', this.stopWorking, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.statusBar', this.statusBar, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.copyIssueNumber', this.copyIssueNumber));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.copyIssueUrl', this.copyIssueUrl));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.refresh', this.refreshView, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.getCurrent', this.getCurrent, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.editQuery', this.editQuery, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.createIssue', this.createIssue, this));
		this.context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromFile', this.createIssueFromFile, this));
		this.context.subscriptions.push(vscode.languages.registerHoverProvider('*', new IssueHoverProvider(this.manager, this._stateManager, this.context)));
		this.context.subscriptions.push(vscode.languages.registerHoverProvider('*', new UserHoverProvider(this.manager)));
		this.context.subscriptions.push(vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider(this.context)));
		this.context.subscriptions.push(vscode.window.registerTreeDataProvider('issues:github', new IssuesTreeData(this._stateManager, this.context)));
		this.context.subscriptions.push(vscode.workspace.registerFileSystemProvider('newIssue', new IssueFileSystemProvider()));
	}

	dispose() { }

	async createIssue() {
		try {
			const defaults = await this.manager.getPullRequestDefaults();
			return vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${defaults.owner}/${defaults.repo}/issues/new/choose`));
		} catch (e) {
			vscode.window.showErrorMessage('Unable to determine where to create the issue.');
		}
	}

	async createIssueFromFile() {
		if (this.createIssueInfo === undefined) {
			return;
		}
		let text: string;
		if (!vscode.window.activeTextEditor) {
			return;
		}
		text = vscode.window.activeTextEditor.document.getText();
		const indexOfEmptyLineWindows = text.indexOf('\r\n\r\n');
		const indexOfEmptyLineOther = text.indexOf('\n\n');
		let indexOfEmptyLine: number;
		if (indexOfEmptyLineWindows < 0 && indexOfEmptyLineOther < 0) {
			return;
		} else {
			if (indexOfEmptyLineWindows < 0) {
				indexOfEmptyLine = indexOfEmptyLineOther;
			} else if (indexOfEmptyLineOther < 0) {
				indexOfEmptyLine = indexOfEmptyLineWindows;
			} else {
				indexOfEmptyLine = Math.min(indexOfEmptyLineWindows, indexOfEmptyLineOther);
			}
		}
		const title = text.substring(0, indexOfEmptyLine);
		const body = text.substring(indexOfEmptyLine + 2);
		if (!title || !body) {
			return;
		}
		await this.doCreateIssue(this.createIssueInfo.document, this.createIssueInfo.newIssue, title, body, this.createIssueInfo.assignee, this.createIssueInfo.lineNumber, this.createIssueInfo.insertIndex);
		this.createIssueInfo = undefined;
		vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}

	async editQuery(query: vscode.TreeItem) {
		const config = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION);
		const inspect = config.inspect<{ label: string, query: string }[]>(QUERIES_CONFIGURATION);
		let command: string;
		if (inspect?.workspaceValue) {
			command = 'workbench.action.openWorkspaceSettingsFile';
		} else {
			command = 'workbench.action.openSettingsJson';
		}
		await vscode.commands.executeCommand(command);
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const text = editor.document.getText();
			const search = text.search(query.label!);
			if (search >= 0) {
				const position = editor.document.positionAt(search);
				editor.revealRange(new vscode.Range(position, position));
				editor.selection = new vscode.Selection(position, position);
			}
		}
	}

	getCurrent() {
		if (this._stateManager.currentIssue) {
			return { owner: this._stateManager.currentIssue.issue.remote.owner, repo: this._stateManager.currentIssue.issue.remote.repositoryName, number: this._stateManager.currentIssue.issue.number };
		}
	}

	refreshView() {
		this._stateManager.refreshCacheNeeded();
	}

	openIssue(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.openExternal(vscode.Uri.parse(issueModel.html_url));
		}
	}

	async startWorking(issue: any) {
		let issueModel: IssueModel | undefined;

		if (issue instanceof IssueModel) {
			issueModel = issue;
		} else if (issue && issue.repo && issue.owner && issue.number) {
			issueModel = await this.manager.resolveIssue(issue.owner, issue.repo, issue.number);
		}

		if (issueModel) {
			await this._stateManager.setCurrentIssue(new CurrentIssue(issueModel, this.manager, this.reviewManager, this._stateManager));
		}
	}

	async startWorkingBranchPrompt(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			await this._stateManager.setCurrentIssue(new CurrentIssue(issueModel, this.manager, this.reviewManager, this._stateManager, true));
		}
	}

	async stopWorking(issueModel: any) {
		if ((issueModel instanceof IssueModel) && (this._stateManager.currentIssue?.issue.number === issueModel.number)) {
			await this._stateManager.setCurrentIssue(undefined);
		}
	}

	async statusBar() {
		if (this._stateManager.currentIssue) {
			const openIssueText: string = `$(globe) Open #${this._stateManager.currentIssue.issue.number} ${this._stateManager.currentIssue.issue.title}`;
			const pullRequestText: string = `$(git-pull-request) Create pull request for #${this._stateManager.currentIssue.issue.number} (pushes branch)`;
			const draftPullRequestText: string = `$(comment-discussion) Create draft pull request for #${this._stateManager.currentIssue.issue.number} (pushes branch)`;
			let defaults: PullRequestDefaults | undefined;
			try {
				defaults = await this.manager.getPullRequestDefaults();
			} catch (e) {
				// leave defaults undefined
			}
			const applyPatch: string = `$(beaker) Apply and patch of commits from ${this._stateManager.currentIssue.branchName} to ${defaults?.base}`;
			const stopWorkingText: string = `$(circle-slash) Stop working on #${this._stateManager.currentIssue.issue.number}`;
			const choices = this._stateManager.currentIssue.branchName && defaults ? [openIssueText, pullRequestText, draftPullRequestText, applyPatch, stopWorkingText] : [openIssueText, pullRequestText, draftPullRequestText, stopWorkingText];
			const response: string | undefined = await vscode.window.showQuickPick(choices, { placeHolder: 'Current issue options' });
			switch (response) {
				case openIssueText: return this.openIssue(this._stateManager.currentIssue.issue);
				case pullRequestText: return pushAndCreatePR(this.manager, this.reviewManager);
				case draftPullRequestText: return pushAndCreatePR(this.manager, this.reviewManager, true);
				case applyPatch: return this.applyPatch(defaults ? defaults.base : '', this._stateManager.currentIssue.branchName!);
				case stopWorkingText: return this._stateManager.setCurrentIssue(undefined);
			}
		}
	}

	private stringToUint8Array(input: string): Uint8Array {
		const encoder = new TextEncoder();
		return encoder.encode(input);
	}

	private async applyPatch(baseBranch: string, workingBranch: string): Promise<void> {
		let patch: vscode.Uri | undefined;
		try {
			const base = await this.manager.repository.getBranch(baseBranch);
			const currentHead = this.manager.repository.state.HEAD;
			if (!base || !currentHead?.commit || !base.commit) {
				vscode.window.showErrorMessage(`Current branch ${workingBranch} does not have base branch.`);
				return;
			}
			const mergeBase = await this.manager.repository.getMergeBase(currentHead.commit, base.commit);
			const message = (await this.manager.repository.getCommit(mergeBase)).message;
			const diffToApply = await this.manager.repository.diffBetween(mergeBase, currentHead.commit, '.');
			const storagePath = vscode.Uri.file(this.context.storagePath!);
			try {
				await vscode.workspace.fs.createDirectory(storagePath);
			} catch (e) {
				// do nothing, the file exists
			}
			patch = vscode.Uri.joinPath(storagePath, 'diff.patch');
			await vscode.workspace.fs.writeFile(patch, this.stringToUint8Array(diffToApply));

			await this.manager.repository.checkout(baseBranch);
			await this.manager.repository.pull();
			await this.manager.repository.apply(patch.fsPath);
			(<Repository><any>this.manager.repository).inputBox.value = message;
		} catch (e) {
			vscode.window.showErrorMessage('Could not complete patch: ' + e);
		}
	}

	copyIssueNumber(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.number.toString());
		}
	}

	copyIssueUrl(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.html_url);
		}
	}

	async createTodoIssueClipboard() {
		return this.createTodoIssue(undefined, await vscode.env.clipboard.readText());
	}

	async createTodoIssue(newIssue?: NewIssue, issueBody?: string) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		let assignee: string | undefined;
		let issueGenerationText: string | undefined;
		if (!newIssue && vscode.window.activeTextEditor) {
			document = vscode.window.activeTextEditor.document;
			issueGenerationText = document.getText(vscode.window.activeTextEditor.selection);
		} else if (newIssue) {
			document = newIssue.document;
			insertIndex = newIssue.insertIndex;
			lineNumber = newIssue.lineNumber;
			titlePlaceholder = newIssue.line.substring(insertIndex, newIssue.line.length).trim();
			issueGenerationText = document.getText(newIssue.range.isEmpty ? document.lineAt(newIssue.range.start.line).range : newIssue.range);
		} else {
			return undefined;
		}
		const matches = issueGenerationText.match(USER_EXPRESSION);
		if (matches && matches.length === 2 && this._stateManager.userMap.has(matches[1])) {
			assignee = matches[1];
		}
		let title: string | undefined;
		const body: string | undefined = issueBody || newIssue?.document.isUntitled ? issueBody : await createGithubPermalink(this.manager, newIssue);

		const quickInput = vscode.window.createInputBox();
		quickInput.value = titlePlaceholder ?? '';
		quickInput.prompt = 'Set the issue title. Confirm to create the issue now or use the edit button to edit the issue description.';
		quickInput.title = 'Create Issue';
		quickInput.buttons = [
			{
				iconPath: {
					light: Resource.icons.light.Edit,
					dark: Resource.icons.dark.Edit
				},
				tooltip: 'Edit Description'
			}
		];
		quickInput.onDidAccept(async () => {
			title = quickInput.value;
			if (title) {
				quickInput.busy = true;
				await this.doCreateIssue(document, newIssue, title, body, assignee, lineNumber, insertIndex);
				quickInput.busy = false;
			}
			quickInput.hide();
		});
		quickInput.onDidTriggerButton(async () => {

			title = quickInput.value;
			quickInput.busy = true;
			this.createIssueInfo = { document, newIssue, assignee, lineNumber, insertIndex };

			const bodyPath = vscode.Uri.parse('newIssue:/NewIssue.md');
			const text = `${title}\n\n${body ?? ''}\n\n<!--Edit the body of your new issue then click the ✓ \"Create Issue\" button in the top right of the editor. The first line will be the issue title. Leave an empty line after the title.-->`;
			await vscode.workspace.fs.writeFile(bodyPath, this.stringToUint8Array(text));
			await vscode.window.showTextDocument(bodyPath);
			quickInput.busy = false;
			quickInput.hide();
		});
		quickInput.show();
	}

	private async doCreateIssue(document: vscode.TextDocument, newIssue: NewIssue | undefined, title: string, issueBody: string | undefined, assignee: string | undefined, lineNumber: number | undefined, insertIndex: number | undefined) {
		let origin: PullRequestDefaults | undefined;
		try {
			origin = await this.manager.getPullRequestDefaults();
		} catch (e) {
			// There is no remote
			vscode.window.showErrorMessage('There is no remote. Can\'t create an issue.');
			return;
		}
		const body: string | undefined = issueBody || newIssue?.document.isUntitled ? issueBody : await createGithubPermalink(this.manager, newIssue);
		const issue = await this.manager.createIssue({
			owner: origin.owner,
			repo: origin.repo,
			title,
			body,
			assignee
		});
		if (issue) {
			if ((insertIndex !== undefined) && (lineNumber !== undefined)) {
				const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
				const insertText: string = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('createInsertFormat', 'number') === 'number' ? `#${issue.number}` : issue.html_url;
				edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex), ` ${insertText}`);
				await vscode.workspace.applyEdit(edit);
			} else {
				await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
			}
			this._stateManager.refreshCacheNeeded();
		}
	}

	private async getPermalinkWithError(): Promise<string | undefined> {
		const link: string | undefined = await createGithubPermalink(this.manager);
		if (!link) {
			vscode.window.showWarningMessage('Unable to create a GitHub permalink for the selection. Check that your local branch is tracking a remote branch.');
		}
		return link;
	}

	async copyPermalink() {
		const link = await this.getPermalinkWithError();
		if (link) {
			vscode.env.clipboard.writeText(link);
			vscode.window.showInformationMessage('Link copied to clipboard.');
		}
	}

	async openPermalink() {
		const link = await this.getPermalinkWithError();
		if (link) {
			vscode.env.openExternal(vscode.Uri.parse(link));
		}
	}
}