/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const minimist = require('minimist');
const path = require('path');

const argv = minimist(process.argv.slice(2), {
	string: ['in', 'out'],
	boolean: ['help'],
	alias: { h: 'help', i: 'in', o: 'out' },
	unknown: param => {
		console.error(`Unrecognized command-line argument: ${param}\n`);
		printUsage(console.error, 1);
	},
});

if (argv.help) {
	printUsage(console.log, 0);
}

const inFilename = argv.in;
const outFilename = argv.out;

function copyFixtures(inputDir, outputDir) {
	// Get a list of all files and directories in the input directory
	const files = fs.readdirSync(inputDir);

	// Iterate over each file/directory
	for (const file of files) {
		const filePath = path.join(inputDir, file);
		const stats = fs.statSync(filePath);
		const isDir = stats.isDirectory();

		if (isDir) {
			if (file === 'fixtures') {
				const outputFilePath = path.join(outputDir, inputDir, file);
				const inputFilePath = path.join(inputDir, file);
				fs.cpSync(inputFilePath, outputFilePath, { recursive: true, force: true, });

			} else {
				copyFixtures(filePath, outputDir);
			}
		}
	}
}

copyFixtures(inFilename, outFilename);