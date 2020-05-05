import * as path from 'path';
import { runTests } from 'vscode-test';

async function go() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		const extensionTestsPath = path.resolve(__dirname, './');

		/**
		 * Basic usage
		 */
		await runTests({
			version: 'insiders',
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				'--disable-extensions'
			]
		});
	} catch (e) {
		console.log(e);
	}
}

go();