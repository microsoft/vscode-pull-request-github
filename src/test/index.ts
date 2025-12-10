/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// This file is providing the test runner to use when running extension tests.
import * as path from 'path';
import * as vscode from 'vscode';
import glob from 'glob';
import Mocha from 'mocha';
import { mockWebviewEnvironment } from './mocks/mockWebviewEnvironment';
import { EXTENSION_ID } from '../constants';


async function runAllExtensionTests(testsRoot: string, clb: (error: Error | null, failures?: number) => void): Promise<any> {
	// Ensure the dev-mode extension is activated
	await vscode.extensions.getExtension(EXTENSION_ID)!.activate();

	mockWebviewEnvironment.install(global);

	const mocha = new Mocha({
		ui: 'bdd',
		color: true
	});
	// Load globalHooks if it exists
	try {
		mocha.addFile(path.resolve(testsRoot, 'globalHooks.js'));
	} catch (e) {
		// globalHooks might not exist in webpack bundle, ignore
	}

	// Import all test files using webpack's require.context
	try {
		// Load tests from src/test directory only
		// Webview tests are compiled separately with the webview configuration
		const importAll = (r: __WebpackModuleApi.RequireContext) => r.keys().forEach(r);
		importAll(require.context('./', true, /\.test$/));
	} catch (e) {
		// Fallback if 'require.context' is not available (e.g., in non-webpack environments)
		const files = glob.sync('**/*.test.js', {
			cwd: testsRoot,
			absolute: true,
			// Browser/webview tests are loaded via the separate browser runner
			ignore: ['browser/**']
		});
		if (!files.length) {
			console.log('Fallback test discovery found no test files. Original error:', e);
		}
		for (const f of files) {
			mocha.addFile(f);
		}
	}

	if (process.env.TEST_JUNIT_XML_PATH) {
		mocha.reporter('mocha-multi-reporters', {
			reporterEnabled: 'mocha-junit-reporter, spec',
			mochaJunitReporterReporterOptions: {
				mochaFile: process.env.TEST_JUNIT_XML_PATH,
				suiteTitleSeparatedBy: ' / ',
				outputs: true,
			},
		});
	}

	return mocha.run(failures => clb(null, failures));
}

export function run(testsRoot: string, clb: (error: Error | null, failures?: number) => void): void {
	require('source-map-support').install();

	runAllExtensionTests(testsRoot, clb);
}
