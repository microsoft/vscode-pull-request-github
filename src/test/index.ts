// This file is providing the test runner to use when running extension tests.
import * as path from 'path';
import glob from 'glob';
import Mocha from 'mocha';

import { mockWebviewEnvironment } from './mocks/mockWebviewEnvironment';

// Linux: prevent a weird NPE when mocha on Linux requires the window size from the TTY
// Since we are not running in a tty environment, we just implement the method statically.
// This is copied verbatim from the upstream, default Mocha test runner:
// https://github.com/microsoft/vscode-extension-vscode/blob/master/lib/testrunner.ts
const tty = require('tty') as any;
if (!tty.getWindowSize) {
	tty.getWindowSize = function () {
		return [80, 75];
	};
}

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
	mockWebviewEnvironment.install(global);

	const mocha = new Mocha({
		ui: 'bdd',
		useColors: true,
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
