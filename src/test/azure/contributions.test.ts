/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../../constants';
import { Schemes } from '../../common/uri';

const extension = vscode.extensions.getExtension(EXTENSION_ID);
if (!extension) {
	throw new Error('Run contribution tests in the extension development host.');
}
const root = extension.extensionPath;
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('Standalone fork contributions', () => {
	it('keeps a stable standalone extension identity', () => {
		assert.strictEqual(`${manifest.publisher}.${manifest.name}`, EXTENSION_ID);
		assert.strictEqual(EXTENSION_ID, 'jhare96.vscode-pull-request-azdo');
	});

	it('retains the original view surfaces under independent identifiers', () => {
		const views: { id: string }[] = Object.values(manifest.contributes.views).flat() as { id: string }[];
		assert.ok(views.some(view => view.id === 'pr:azureDevOps'));
		assert.ok(views.some(view => view.id === 'azureDevOps:createPullRequestWebview'));
		assert.ok(views.some(view => view.id === 'azureDevOps:activePullRequest'));
		assert.ok(views.every(view => !view.id.includes('github')));
		const commands: { command: string }[] = manifest.contributes.commands;
		assert.ok(commands.length > 150, 'Keep the original workflow actions, not an Azure replacement command set.');
		assert.ok(commands.every(command => command.command.startsWith('azdo.')));
	});

	it('namespaces configuration, chat tools, contexts and custom document providers', () => {
		assert.ok(Object.keys(manifest.contributes.configuration.properties).every(key => key.startsWith('azureDevOps')));
		const tools: { name: string; toolReferenceName: string }[] = manifest.contributes.languageModelTools;
		assert.ok(tools.every(tool => tool.name.startsWith('azure-devops-') && tool.toolReferenceName.startsWith('azdo_')));
		const contexts: { id: string }[] = manifest.contributes.chatContext;
		assert.ok(contexts.every(context => context.id.startsWith('azdo')));
		assert.strictEqual(Schemes.Pr, 'azdo-pr');
		assert.strictEqual(Schemes.Review, 'azdo-review');
		assert.strictEqual(Schemes.CheckRunLog, 'azdocheckrunlog');
		assert.ok(manifest.activationEvents.includes(`onFileSystem:${Schemes.NewIssue}`));
	});

	it('builds and hosts the original overview and creation forms, not separate Azure pages', () => {
		const webpack = readFileSync(path.join(root, 'webpack.config.js'), 'utf8');
		assert.ok(webpack.includes('webviews/editorWebview/index.ts'));
		assert.ok(webpack.includes('webviews/createPullRequestViewNew/index.ts'));
		assert.ok(!webpack.includes('azureOverview'));
		assert.strictEqual(existsSync(path.join(root, 'src/azure/extension.ts')), false);
		assert.strictEqual(existsSync(path.join(root, 'webviews/azureOverview')), false);
		const activation = readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
		assert.ok(activation.includes('registerCommands('));
		assert.ok(!activation.includes('activateAzure'));
	});
});
