/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const path = require('path');
const glob = require('glob');
const Mocha = require('mocha');
const webpack = require('webpack');
const installJsDomGlobal = require('jsdom-global');

async function main() {
	const root = path.resolve(__dirname, '..');
	const tests = glob.sync('webviews/**/test/**/*.test.{ts,tsx}', { cwd: root, absolute: true }).sort();
	if (!tests.length) {
		throw new Error('No webview test files found.');
	}

	const configs = await require('../webpack.config')({ esbuild: true }, { mode: 'development' });
	const config = configs.find(config => config.name === 'webviews');
	config.entry = [path.join(root, 'src', 'test', 'webviews', 'setup.ts'), ...tests];
	config.target = 'node';
	config.output = { path: path.join(root, 'out', 'webview-tests'), filename: 'index.js' };
	config.externals = [({ request }, callback) => {
		if (!request.startsWith('.') && !path.isAbsolute(request)) {
			callback(null, 'commonjs ' + request);
		} else {
			callback();
		}
	}];

	await new Promise((resolve, reject) => {
		const compiler = webpack(config);
		compiler.run((error, stats) => compiler.close(closeError => {
			if (error || closeError) {
				reject(error ?? closeError);
			} else if (stats.hasErrors()) {
				reject(new Error(stats.toString('errors-warnings')));
			} else {
				if (stats.hasWarnings()) {
					process.stderr.write(stats.toString('errors-warnings') + '\n');
				}
				resolve();
			}
		}));
	});

	const mocha = new Mocha({ ui: 'bdd', color: true, failZero: true });
	if (process.env.TEST_JUNIT_XML_PATH) {
		const report = process.env.TEST_JUNIT_XML_PATH;
		mocha.reporter('mocha-multi-reporters', {
			reporterEnabled: 'mocha-junit-reporter, spec',
			mochaJunitReporterReporterOptions: {
				mochaFile: path.join(path.dirname(report), `webviews-${path.basename(report)}`),
				suiteTitleSeparatedBy: ' / ',
				outputs: true,
			},
		});
	}

	const cleanup = installJsDomGlobal('', { pretendToBeVisual: true });
	// Match JSDOM's APIs rather than exposing Node's MessageChannel to React's scheduler.
	const messageChannel = global.MessageChannel;
	global.MessageChannel = window.MessageChannel;
	try {
		require('source-map-support').install();
		mocha.addFile(path.join(config.output.path, config.output.filename));
		const failures = await new Promise(resolve => mocha.run(resolve));
		process.exitCode = failures ? 1 : 0;
	} finally {
		mocha.dispose();
		window.close();
		cleanup();
		global.MessageChannel = messageChannel;
	}
}

main().catch(error => {
	process.stderr.write(`${error.stack ?? error}\n`);
	process.exitCode = 1;
});
