/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
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
	// On macOS, VS Code creates its IPC socket in the user data dir, and Unix socket paths are limited to ~103 chars.
	// The default (.vscode-test/user-data in the repo) is too long for deep checkouts, so use a short temp dir.
	const userDataDir = process.platform === 'darwin' ? mkdtempSync(path.join(os.tmpdir(), 'vscode-test-')) : undefined;
	const launchArgs = ['--disable-extensions'];
	if (userDataDir) {
		launchArgs.push(`--user-data-dir=${userDataDir}`);
	}
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
			launchArgs,
		});
	} catch (e) {
		console.log(e);
		process.exitCode = 1;
	} finally {
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	}
}

setTimeout(() => go(), 10000);
