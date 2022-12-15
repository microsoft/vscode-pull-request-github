import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function go() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
		const extensionTestsPath = path.resolve(__dirname, './');
		console.log(extensionDevelopmentPath, extensionTestsPath);

		/**
		 * Basic usage
		 */
		await runTests({
			version: 'insiders',
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
