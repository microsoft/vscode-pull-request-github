/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
let defaultStorage: vscode.Memento | undefined = undefined;

export function init(ctx: vscode.ExtensionContext) {
	defaultStorage = ctx.globalState;
}

export async function setPreference(key: string, value: any) {
	await defaultStorage!.update(key, value);
}

export function getPreference(key: string) {
	return defaultStorage!.get(key);
}