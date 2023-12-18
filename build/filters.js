/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Largely copied from https://github.com/microsoft/vscode/blob/72208d7bbb0e151a54f012ffb382095f0f4c5ba4/build/filters.js

/**
 * Hygiene works by creating cascading subsets of all our files and
 * passing them through a sequence of checks. Here are the current subsets,
 * named according to the checks performed on them.
 */

module.exports.all = [
	'*',
	'build/**/*',
	'common/**/*',
	'scripts/**/*',
	'src/**/*',
	'test/**/*',
	'webviews/**/*'
];

module.exports.unicodeFilter = [
	'**',
	// except specific files
	'!documentation/**/*',
	'!**/ThirdPartyNotices.txt',
	'!**/LICENSE.{txt,rtf}',
	'!**/LICENSE',
	'!*.yml'
];

module.exports.indentationFilter = [
	'**',

	// except specific files
	'!CHANGELOG.md',
	'!documentation/**/*',
	'!**/ThirdPartyNotices.txt',
	'!**/LICENSE.{txt,rtf}',
	'!**/LICENSE',
	'!**/*.yml',

	// except multiple specific files
	'!**/package.json',
	'!**/yarn.lock',
	'!**/yarn-error.log'
];

module.exports.copyrightFilter = [
	'**',
	'!documentation/**/*',
	'!.readme/**/*',
	'!.vscode/**/*',
	'!.github/**/*',
	'!.husky/**/*',
	'!tsfmt.json',
	'!**/queries*.gql',
	'!**/*.yml',
	'!**/*.md',
	'!package.nls.json',
	'!**/*.svg',
	'!src/integrations/gitlens/gitlens.d.ts'
];

module.exports.tsFormattingFilter = [
	'src/**/*.ts',
	'common/**/*.ts',
	'webviews/**/*.ts',
];

