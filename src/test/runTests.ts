import * as path from 'path';
import { runTests } from 'vscode-test';
import * as dotenv from 'dotenv';

async function go() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		const extensionTestsPath = path.resolve(__dirname, './');

		dotenv.config();

		/**
		 * Basic usage
		 */
		await runTests({
			version: 'insiders',
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				path.resolve(__dirname,'../../test_workspace/'),
				'--disable-extensions'
			]
		});
	} catch (e) {
		console.log(e);
	}
}

go();