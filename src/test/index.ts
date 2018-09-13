// This file is providing the test runner to use when running extension tests.
import * as testRunner from 'vscode/lib/testrunner';

// You can directly control Mocha options by uncommenting the following lines
// See https://github.com/mochajs/mocha/wiki/Using-mocha-programmatically#set-options for more info
testRunner.configure({
	ui: 'bdd', 		// the BDD UI is being used in extension.test.ts (describe, it, etc.)
	useColors: true // colored output from test results
});

module.exports = testRunner;