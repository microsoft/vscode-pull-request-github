/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Verifies that every command declared in package.json under contributes.commands
 * has a corresponding vscode.commands.registerCommand('<commandId>' ...) call in the source.
 * Exits with non-zero status if any are missing.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getDeclaredCommands(pkg) {
	const contributes = pkg.contributes || {};
	const commands = contributes.commands || [];
	const ids = [];
	for (const cmd of commands) {
		if (cmd && typeof cmd.command === 'string') {
			ids.push(cmd.command);
		}
	}
	return ids;
}

function getRegisteredCommands(workspaceRoot) {
	const files = glob.sync('src/**/*.ts', { cwd: workspaceRoot, ignore: ['**/node_modules/**', '**/dist/**', '**/out/**'] });
	const registered = new Set();
	const regex = /vscode\.commands\.(registerCommand|registerDiffInformationCommand)\s*\(\s*[']([^'\n]+)[']/g;
	for (const rel of files) {
		const full = path.join(workspaceRoot, rel);
		let content;
		try {
			content = fs.readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		let match;
		while ((match = regex.exec(content)) !== null) {
			registered.add(match[2]);
		}
	}
	return registered;
}

function main() {
	const workspaceRoot = path.resolve(__dirname, '..');
	const pkgPath = path.join(workspaceRoot, 'package.json');
	const pkg = readJson(pkgPath);
	const declared = getDeclaredCommands(pkg);
	const registered = getRegisteredCommands(workspaceRoot);

	const missing = declared.filter(id => !registered.has(id));

	if (missing.length) {
		console.error('ERROR: The following commands are declared in package.json but not registered:');
		for (const m of missing) {
			console.error('  - ' + m);
		}
		console.error('\nAdd a corresponding vscode.commands.registerCommand("<id>", ...) call.');
		process.exit(1);
	} else {
		console.log('All declared commands are registered.');
	}
}

main();
