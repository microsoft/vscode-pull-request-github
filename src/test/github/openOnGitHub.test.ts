/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { openItemOnGitHub } from '../../commands';
import { IssueModel } from '../../github/issueModel';
import { openIssueOrPullRequestOnGitHub } from '../../github/openOnGitHub';
import { PullRequestModel } from '../../github/pullRequestModel';
import { NotificationTreeItem } from '../../notifications/notificationItem';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('openIssueOrPullRequestOnGitHub', () => {
	let openExternal: SinonStub;
	let sandbox: SinonSandbox;
	let telemetry: MockTelemetry;

	beforeEach(() => {
		sandbox = createSandbox();
		telemetry = new MockTelemetry();
		openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('sends pull request telemetry', async () => {
		const sendTelemetryEvent = sandbox.spy(telemetry, 'sendTelemetryEvent');
		const uri = vscode.Uri.parse('https://github.com/microsoft/vscode/pull/1');

		await openIssueOrPullRequestOnGitHub(uri, 'pullRequest', telemetry);

		assert.ok(sendTelemetryEvent.calledOnceWith('pr.openInGitHub'));
		assert.ok(openExternal.calledOnceWith(uri, { allowContributedOpeners: 'default' }));
	});

	it('sends issue telemetry', async () => {
		const sendTelemetryEvent = sandbox.spy(telemetry, 'sendTelemetryEvent');
		const uri = vscode.Uri.parse('https://github.com/microsoft/vscode/issues/1');

		await openIssueOrPullRequestOnGitHub(uri, 'issue', telemetry);

		assert.ok(sendTelemetryEvent.calledOnceWith('issue.openOnGitHub'));
		assert.ok(openExternal.calledOnceWith(uri, { allowContributedOpeners: 'default' }));
	});

	it('classifies pull request models', async () => {
		const sendTelemetryEvent = sandbox.spy(telemetry, 'sendTelemetryEvent');
		const pullRequest: PullRequestModel = Object.assign(Object.create(PullRequestModel.prototype), {
			html_url: 'https://github.com/microsoft/vscode/pull/1',
		});

		await openItemOnGitHub(pullRequest, telemetry);

		assert.ok(sendTelemetryEvent.calledOnceWith('pr.openInGitHub'));
	});

	it('classifies issue models', async () => {
		const sendTelemetryEvent = sandbox.spy(telemetry, 'sendTelemetryEvent');
		const issue: IssueModel = Object.assign(Object.create(IssueModel.prototype), {
			html_url: 'https://github.com/microsoft/vscode/issues/1',
		});

		await openItemOnGitHub(issue, telemetry);

		assert.ok(sendTelemetryEvent.calledOnceWith('issue.openOnGitHub'));
	});

	it('classifies pull request notifications', async () => {
		const sendTelemetryEvent = sandbox.spy(telemetry, 'sendTelemetryEvent');
		const pullRequest: PullRequestModel = Object.assign(Object.create(PullRequestModel.prototype), {
			html_url: 'https://github.com/microsoft/vscode/pull/1',
		});
		const notification: NotificationTreeItem = {
			kind: 'notification',
			model: pullRequest,
			notification: Object.create(null),
		};

		await openItemOnGitHub(notification, telemetry);

		assert.ok(sendTelemetryEvent.calledOnceWith('pr.openInGitHub'));
	});
});
