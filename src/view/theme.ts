/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { parse } from 'jsonc-parser';
import * as vscode from 'vscode';

export async function loadCurrentThemeData(): Promise<ThemeData> {
	let themeData: any = null;
	const currentThemeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
	if (currentThemeName) {
		const path = getCurrentThemePath(currentThemeName);
		if (path) {
			themeData = await loadThemeFromFile(path);
		}
	}
	return themeData;
}

interface ThemeData {
	type: string,
	colors: { [key: string]: string }
	tokenColors: any[],
	semanticTokenColors: any[]
}

async function loadThemeFromFile(path: vscode.Uri): Promise<ThemeData> {
	const decoder = new TextDecoder();
	const decoded = decoder.decode(await vscode.workspace.fs.readFile(path));
	let themeData = parse(decoded);

	// Also load the include file if specified
	if (themeData.include) {
		try {
			const includePath = vscode.Uri.joinPath(path, '..', themeData.include);
			const includeData = await loadThemeFromFile(includePath);
			themeData = {
				...themeData,
				colors: {
					...(includeData.colors || {}),
					...(themeData.colors || {}),
				},
				tokenColors: [
					...(includeData.tokenColors || []),
					...(themeData.tokenColors || []),
				],
				semanticTokenColors: {
					...(includeData.semanticTokenColors || {}),
					...(themeData.semanticTokenColors || {}),
				},
			};
		} catch (error) {
			console.warn(`Failed to load theme include file: ${error}`);
		}
	}

	return themeData;
}

function getCurrentThemePath(themeName: string): vscode.Uri | undefined {
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
		if (!themes) {
			continue;
		}
		const theme = themes.find(theme => theme.label === themeName || theme.id === themeName);
		if (theme) {
			return vscode.Uri.joinPath(ext.extensionUri, theme.path);
		}
	}
}