/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from './common/lifecycle';
import { COLOR_THEME, WORKBENCH } from './common/settingKeys';
import { loadCurrentThemeData, ThemeData } from './view/theme';

export class ThemeWatcher extends Disposable {
	private _themeData: ThemeData | undefined;
	private _onDidChangeTheme = this._register(new vscode.EventEmitter<ThemeData | undefined>());
	readonly onDidChangeTheme = this._onDidChangeTheme.event;

	constructor() {
		super();
		this._register(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${WORKBENCH}.${COLOR_THEME}`)) {
					await this.updateTheme();
				}
			}),
		);
		this.updateTheme();
	}

	async updateTheme() {
		this._themeData = await loadCurrentThemeData();
		this._onDidChangeTheme.fire(this._themeData);
	}

	get themeData() {
		return this._themeData;
	}
}