/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { registerCommands } from '../commands';
import { parseDiffHunk } from '../common/diffHunk';
import { MockCommandRegistry } from './mocks/mockCommandRegistry';

describe('Extension Tests', function () {
	describe('Hello World Command', () => {
		let sandbox: sinon.SinonSandbox;
		let mockCommands: MockCommandRegistry;
		let mockShowInformationMessage: sinon.SinonStub;
		let mockTelemetry: any;

		beforeEach(() => {
			sandbox = sinon.createSandbox();
			mockCommands = new MockCommandRegistry(sandbox);
			mockShowInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage');
			mockTelemetry = {
				sendTelemetryEvent: sandbox.stub()
			};
		});

		afterEach(() => {
			sandbox.restore();
		});

		it('should register and execute pr.helloWorld command', () => {
			// Mock the required dependencies
			const mockContext = {
				subscriptions: []
			} as any;
			const mockReposManager = {} as any;
			const mockReviewsManager = {} as any;
			const mockTree = {} as any;
			const mockCopilotRemoteAgentManager = {} as any;

			// Register commands
			registerCommands(mockContext, mockReposManager, mockReviewsManager, mockTelemetry, mockTree, mockCopilotRemoteAgentManager);

			// Execute the hello world command
			mockCommands.executeCommand('pr.helloWorld');

			// Verify the command was executed correctly
			assert(mockShowInformationMessage.calledOnce, 'showInformationMessage should be called once');
			assert(mockShowInformationMessage.calledWith('Hello World'), 'showInformationMessage should be called with "Hello World"');
			assert(mockTelemetry.sendTelemetryEvent.calledOnce, 'sendTelemetryEvent should be called once');
			assert(mockTelemetry.sendTelemetryEvent.calledWith('pr.helloWorld'), 'sendTelemetryEvent should be called with correct event name');
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
