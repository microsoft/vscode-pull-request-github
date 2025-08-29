/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';
import { chatCommand } from '../lm/utils';
import { PR_SETTINGS_NAMESPACE, QUERIES, USE_REVIEW_MODE } from './settingKeys';

export function getReviewMode(): { merged: boolean, closed: boolean } {
	const desktopDefaults = { merged: false, closed: false };
	const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE)
		.get<{ merged: boolean, closed: boolean } | 'auto'>(USE_REVIEW_MODE, desktopDefaults);
	if (config !== 'auto') {
		return config;
	}
	if (vscode.env.appHost === 'vscode.dev' || vscode.env.appHost === 'github.dev') {
		return { merged: true, closed: true };
	}
	return desktopDefaults;
}

export function initBasedOnSettingChange(namespace: string, key: string, isEnabled: () => boolean, initializer: () => void, disposables: vscode.Disposable[]): void {
	const eventDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(`${namespace}.${key}`)) {
			if (isEnabled()) {
				initializer();
				eventDisposable.dispose();
			}
		}
	});
	disposables.push(eventDisposable);
}

interface QueryInspect {
	key: string;
	defaultValue?: { label: string; query: string }[];
	globalValue?: { label: string; query: string }[];
	workspaceValue?: { label: string; query: string }[];
	workspaceFolderValue?: { label: string; query: string }[];
	defaultLanguageValue?: { label: string; query: string }[];
	globalLanguageValue?: { label: string; query: string }[];
	workspaceLanguageValue?: { label: string; query: string }[];
	workspaceFolderLanguageValue?: { label: string; query: string }[];
	languageIds?: string[]
}

export function editQuery(namespace: string, queryName: string) {
	const config = vscode.workspace.getConfiguration(namespace);
	const inspect = config.inspect<{ label: string; query: string }[]>(QUERIES);
	const queryValue = config.get<{ label: string; query: string }[]>(QUERIES)?.find((query) => query.label === queryName)?.query;

	const inputBox = vscode.window.createQuickPick();
	inputBox.title = vscode.l10n.t('Edit Query "{0}"', queryName ?? '');
	inputBox.value = queryValue ?? '';
	inputBox.items = [
		{ iconPath: new vscode.ThemeIcon('pencil'), label: vscode.l10n.t('Save edits'), alwaysShow: true }, 
		{ iconPath: new vscode.ThemeIcon('add'), label: vscode.l10n.t('Add new query'), alwaysShow: true }, 
		{ iconPath: new vscode.ThemeIcon('settings'), label: vscode.l10n.t('Edit in settings.json'), alwaysShow: true },
		{ iconPath: new vscode.ThemeIcon('copilot'), label: vscode.l10n.t('Edit with Copilot'), alwaysShow: true }
	];
	inputBox.activeItems = [];
	inputBox.selectedItems = [];
	inputBox.onDidAccept(async () => {
		inputBox.busy = true;
		if (inputBox.selectedItems[0] === inputBox.items[0]) {
			const newQuery = inputBox.value;
			if (newQuery !== queryValue) {
				let newValue: { label: string; query: string }[];
				let target: vscode.ConfigurationTarget;
				if (inspect?.workspaceFolderValue) {
					target = vscode.ConfigurationTarget.WorkspaceFolder;
					newValue = inspect.workspaceFolderValue;
				} else if (inspect?.workspaceValue) {
					target = vscode.ConfigurationTarget.Workspace;
					newValue = inspect.workspaceValue;
				} else {
					target = vscode.ConfigurationTarget.Global;
					newValue = config.get<{ label: string; query: string }[]>(QUERIES) ?? [];
				}
				newValue.find((query) => query.label === queryName)!.query = newQuery;
				await config.update(QUERIES, newValue, target);
			}
		} else if (inputBox.selectedItems[0] === inputBox.items[1]) {
			addNewQuery(config, inspect, inputBox.value);
		} else if (inputBox.selectedItems[0] === inputBox.items[2]) {
			openSettingsAtQuery(config, inspect, queryName);
		} else if (inputBox.selectedItems[0] === inputBox.items[3]) {
			await openCopilotForQuery(queryName, inputBox.value);
		}
		inputBox.dispose();
	});
	inputBox.onDidHide(() => inputBox.dispose());
	inputBox.show();
}

function addNewQuery(config: vscode.WorkspaceConfiguration, inspect: QueryInspect | undefined, startingValue: string) {
	const inputBox = vscode.window.createInputBox();
	inputBox.title = vscode.l10n.t('Enter the title of the new query');
	inputBox.placeholder = vscode.l10n.t('Title');
	inputBox.step = 1;
	inputBox.totalSteps = 2;
	inputBox.show();
	let title: string | undefined;
	inputBox.onDidAccept(async () => {
		inputBox.validationMessage = '';
		if (inputBox.step === 1) {
			if (!inputBox.value) {
				inputBox.validationMessage = vscode.l10n.t('Title is required');
				return;
			}

			title = inputBox.value;
			inputBox.value = startingValue;
			inputBox.title = vscode.l10n.t('Enter the GitHub search query');
			inputBox.step++;
		} else {
			if (!inputBox.value) {
				inputBox.validationMessage = vscode.l10n.t('Query is required');
				return;
			}
			inputBox.busy = true;
			if (inputBox.value && title) {
				if (inspect?.workspaceValue) {
					inspect.workspaceValue.push({ label: title, query: inputBox.value });
					await config.update(QUERIES, inspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
				} else {
					const value = config.get<{ label: string; query: string }[]>(QUERIES);
					value?.push({ label: title, query: inputBox.value });
					await config.update(QUERIES, value, vscode.ConfigurationTarget.Global);
				}
			}
			inputBox.dispose();
		}
	});
	inputBox.onDidHide(() => inputBox.dispose());
}

async function openSettingsAtQuery(config: vscode.WorkspaceConfiguration, inspect: QueryInspect | undefined, queryName: string) {
	let command: string;
	if (inspect?.workspaceValue) {
		command = 'workbench.action.openWorkspaceSettingsFile';
	} else {
		const value = config.get<{ label: string; query: string }[]>(QUERIES);
		if (inspect?.defaultValue && JSON.stringify(inspect?.defaultValue) === JSON.stringify(value)) {
			await config.update(QUERIES, inspect.defaultValue, vscode.ConfigurationTarget.Global);
		}
		command = 'workbench.action.openSettingsJson';
	}
	await vscode.commands.executeCommand(command);
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const text = editor.document.getText();
		const search = text.search(queryName);
		if (search >= 0) {
			const position = editor.document.positionAt(search);
			editor.revealRange(new vscode.Range(position, position));
			editor.selection = new vscode.Selection(position, position);
		}
	}
}

async function openCopilotForQuery(queryName: string, currentQuery: string) {
	// Create a chat query that leverages the @githubpr participant and existing tools
	const chatMessage = vscode.l10n.t('@githubpr Help me improve this GitHub search query: "{0}". The current query is: {1}. Please explain what it does and suggest improvements or help convert natural language requirements to GitHub search syntax.', queryName, currentQuery);
	
	// Open chat with the query pre-populated
	const command = chatCommand();
	await vscode.commands.executeCommand(command, chatMessage);
}