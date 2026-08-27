/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { parseDiffHunk } from '../common/diffHunk';
import { findExactPullRequestNumberMatch, openPullRequestOnGitHubCommand } from '../commands';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { MockTelemetry } from './mocks/mockTelemetry';

const packageJson = require('../../package.json') as {
	contributes: {
		commands: { command: string; icon?: string }[];
		menus: { 'editor/title': { command: string; group?: string; when?: string }[] };
	};
};

describe('Extension Tests', function () {
	describe('openPullRequestOnGitHubCommand', () => {
		let sinon: SinonSandbox;

		beforeEach(() => {
			sinon = createSandbox();
		});

		afterEach(() => {
			sinon.restore();
		});

		it('opens the active PR editor in the browser', async () => {
			const pullRequestUrl = vscode.Uri.parse('https://github.com/aaa/bbb/pull/123');
			const open = sinon.stub(vscode.commands, 'executeCommand').resolves();
			sinon.stub(PullRequestOverviewPanel, 'getCurrentPullRequestUrl').returns(pullRequestUrl);

			await openPullRequestOnGitHubCommand(
				vscode.Uri.parse('webview-panel:/PullRequestOverview'),
				{ folderManagers: [] },
				new MockTelemetry(),
			);

			assert(open.calledOnceWithExactly('vscode.open', pullRequestUrl));
		});
	});

	describe('package contributions', () => {
		it('contributes a globe action to PR editors', () => {
			const action = packageJson.contributes.menus['editor/title'].find(item => item.command === 'pr.openPullRequestOnGitHub' && item.when === "activeWebviewPanelId == 'PullRequestOverview'");
			const command = packageJson.contributes.commands.find(item => item.command === 'pr.openPullRequestOnGitHub');

			assert.deepStrictEqual(action, {
				command: 'pr.openPullRequestOnGitHub',
				group: 'navigation',
				when: "activeWebviewPanelId == 'PullRequestOverview'",
			});
			assert.strictEqual(command?.icon, '$(globe)');
		});
	});

	describe('findExactPullRequestNumberMatch', () => {
		it('prioritizes an exact number over a title match without changing the label', () => {
			const items = [
				{
					label: '#10064 Follow up on #10063',
					description: 'by @octocat',
					prNumber: 10064,
				},
				{
					label: '#10063 Upgrade library to v5',
					description: 'by @hubot',
					prNumber: 10063,
				},
			];

			assert.strictEqual(findExactPullRequestNumberMatch('10063', items), items[1]);
			assert.strictEqual(findExactPullRequestNumberMatch('#10063', items), items[1]);
			assert.strictEqual(findExactPullRequestNumberMatch('1006', items), undefined);
			assert.strictEqual(findExactPullRequestNumberMatch('10063 title', items), undefined);
			assert.strictEqual(items[1].label, '#10063 Upgrade library to v5');
		});
	});

	describe('parseDiffHunk', () => {
		it('should handle empty string', () => {
			const diffHunk = parseDiffHunk('');
			const itr = diffHunk.next();
			assert.strictEqual(itr.done, true);
		});

		it('should handle additions', () => {
			const patch = [
				`@@ -5,6 +5,9 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`+       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`+}`,
				`+if (!$smtp_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 6);
			assert.strictEqual(itr.value.newLength, 9);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 10);
		});

		it('should handle deletions', () => {
			const patch = [
				`@@ -5,9 +5,6 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`-       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`-}`,
				`-if (!$smtp_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 9);
			assert.strictEqual(itr.value.newLength, 6);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 10);
		});

		it('should handle replacements', () => {
			const patch = [
				`@@ -5,9 +5,7 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`-       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`-}`,
				`-if (!$smtp_server) {`,
				`+if (fpt_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 9);
			assert.strictEqual(itr.value.newLength, 7);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 11);
		});
	});
});
