/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import packageJson from '../../../package.json';
import packageNls from '../../../package.nls.json';

describe('Comment and Resolve button', function () {
	it('is localized and disabled when the reply is empty', function () {
		const command = packageJson.contributes.commands.find(command => command.command === 'pr.commentAndResolveReviewThread');
		assert.ok(command);
		assert.strictEqual(command.title, '%command.pr.commentAndResolveReviewThread.title%');
		assert.strictEqual(packageNls['command.pr.commentAndResolveReviewThread.title'], 'Comment and Resolve');
		assert.strictEqual(command.enablement, '!commentIsEmpty');
	});

	it('is an inline reply action only for GitHub threads that can be resolved', function () {
		const menu = packageJson.contributes.menus['comments/commentThread/context']
			.find(item => item.command === 'pr.commentAndResolveReviewThread');
		assert.ok(menu);
		assert.strictEqual(menu.group, 'inline@3');
		assert.strictEqual(menu.when, 'commentController =~ /^github-(browse|review)/ && commentThread =~ /canResolve/');
	});

	it('is hidden from the command palette', function () {
		const menu = packageJson.contributes.menus.commandPalette
			.find(item => item.command === 'pr.commentAndResolveReviewThread');
		assert.ok(menu);
		assert.strictEqual(menu.when, 'false');
	});
});
