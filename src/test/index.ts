// This file is providing the test runner to use when running extension tests.
import * as path from 'path';
import * as vscode from 'vscode';
import glob from 'glob';
import Mocha from 'mocha';
import { mockWebviewEnvironment } from './mocks/mockWebviewEnvironment';
import { EXTENSION_ID } from '../constants';

function addTests(mocha: Mocha, root: string): Promise<void> {
	return new Promise((resolve, reject) => {
		glob('**/**.test.js', { cwd: root }, (error, files) => {
			if (error) {
				return reject(error);
			}

			for (const testFile of files) {
				mocha.addFile(path.join(root, testFile));
			}
			resolve();
		});
	});
}

async function runAllExtensionTests(testsRoot: string, clb: (error: Error | null, failures?: number) => void): Promise<any> {
	// Ensure the dev-mode extension is activated
	await vscode.extensions.getExtension(EXTENSION_ID)!.activate();

	mockWebviewEnvironment.install(global);

	const mocha = new Mocha({
		ui: 'bdd',
		color: true
	});
	mocha.addFile(path.resolve(testsRoot, 'globalHooks.js'));

	await addTests(mocha, testsRoot);
	await addTests(mocha, path.resolve(testsRoot, '../../../webviews/'));

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
