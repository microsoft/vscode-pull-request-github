/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function downloadVSCodeInsiders(): Promise<string> {
	const vscodeExecutablePath = await downloadAndUnzipVSCode('insiders');
	if (process.platform !== 'darwin' || existsSync(vscodeExecutablePath)) {
		return vscodeExecutablePath;
	}

	// VS Code for macOS no longer keeps the legacy Electron executable name.
	const renamedExecutablePath = path.join(path.dirname(vscodeExecutablePath), 'Code - Insiders');
	if (existsSync(renamedExecutablePath)) {
		return renamedExecutablePath;
	}

	throw new Error(`VS Code executable not found at ${vscodeExecutablePath} or ${renamedExecutablePath}`);
}

async function go() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
		const extensionTestsPath = path.resolve(__dirname, './');
		const vscodeExecutablePath = await downloadVSCodeInsiders();
		console.log(extensionDevelopmentPath, extensionTestsPath);

		/**
		 * Basic usage
		 */
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: ['--disable-extensions'],
		});
	} catch (e) {
		console.log(e);
		process.exit(1);
	}
}

setTimeout(() => go(), 10000);
