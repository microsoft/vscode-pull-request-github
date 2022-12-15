/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { BrowserType, runTests } from '@vscode/test-web';

async function go() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
		const extensionTestsPath = path.resolve(__dirname, './index');
		console.log(extensionDevelopmentPath, extensionTestsPath);
		const attachArgName = '--waitForDebugger=';
		const waitForDebugger = process.argv.find(arg => arg.startsWith(attachArgName));
		const browserTypeName = '--browserType=';
		const browserType = process.argv.find(arg => arg.startsWith(browserTypeName));

		/**
		 * Basic usage
		 */
		await runTests({
			browserType: browserType ? <BrowserType>browserType.slice(browserTypeName.length) : 'chromium',
			extensionDevelopmentPath,
			extensionTestsPath,
			waitForDebugger: waitForDebugger ? Number(waitForDebugger.slice(attachArgName.length)) : undefined,
			quality: 'stable'
		});
	} catch (e) {
		console.log(e);
	}
}

go();
