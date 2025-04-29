/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';
import { PR_SETTINGS_NAMESPACE, USE_REVIEW_MODE } from './settingKeys';

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