// This file is providing the test runner to use when running extension tests.
import * as path from 'path';
import glob = require('glob');
import Mocha = require('mocha');

// Linux: prevent a weird NPE when mocha on Linux requires the window size from the TTY
// Since we are not running in a tty environment, we just implement the method statically.
// This is copied verbatim from the upstream, default Mocha test runner:
// https://github.com/microsoft/vscode-extension-vscode/blob/master/lib/testrunner.ts
const tty = require('tty') as any;
if (!tty.getWindowSize) {
	tty.getWindowSize = function () { return [80, 75]; };
}

function runTestsInRoot(root: string): Promise<number> {
	console.log(`running tests in root ${root}`);
	const mocha = new Mocha({
		ui: 'bdd',
		useColors: true,
	});

	return new Promise((resolve, reject) => {
		glob('**/**.test.js', {cwd: root}, (error, files) => {
			if (error) {
				return reject(error);
			}

			for (const testFile of files) {
				mocha.addFile(path.join(root, testFile));
			}

			try {
				mocha.run((failures) => {
					console.log(`finished tests in ${root} - ${failures}`);
					resolve(failures);
				});
			} catch (error) {
				reject(error);
			}
		});
	});
}

async function runAllExtensionTests(testsRoot: string): Promise<number> {
	let failures = await runTestsInRoot(testsRoot);

	const webviewRoot = path.resolve(testsRoot, '../../preview-src/dist/preview-src/test');

	mockWebviewEnvironment.install(global);

	try {
		failures += await runTestsInRoot(webviewRoot);
	} finally {
		mockWebviewEnvironment.uninstall();
	}

	return failures;
}

export function run(testsRoot: string, clb: (error: Error | null, failures?: number) => void): void {
	require('source-map-support').install();

	runAllExtensionTests(testsRoot).then(
		failures => clb(null, failures),
		error => {
			console.error(error.stack);
			clb(error);
		},
	);
}