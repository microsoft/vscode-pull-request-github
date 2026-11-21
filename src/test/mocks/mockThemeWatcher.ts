/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../common/lifecycle';
import type { ThemeData } from '../../view/theme';
import { IThemeWatcher } from '../../themeWatcher';

export class MockThemeWatcher extends Disposable implements IThemeWatcher {
	private _themeData: ThemeData | undefined;
	private _onDidChangeTheme = new vscode.EventEmitter<ThemeData | undefined>();
	readonly onDidChangeTheme = this._onDidChangeTheme.event;

	constructor() {
		super();
		this._themeData = {
			colors: {},
			semanticTokenColors: [],
			tokenColors: [],
			type: 'dark'
		};
	}

	async updateTheme(themeData?: ThemeData) {
		this._themeData = themeData ?? this._themeData;
		this._onDidChangeTheme.fire(this._themeData);
	}

	get themeData() {
		return this._themeData;
	}
}
