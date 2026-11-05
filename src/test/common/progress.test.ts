/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { PausableProgressNotification } from '../../common/progress';

describe('PausableProgressNotification', function () {
	let sinon: SinonSandbox;
	/** Every notification that was opened, with the messages it showed and whether it is still open. */
	let notifications: { title?: string; messages: (string | undefined)[]; open: boolean }[];
	let startNotifications: () => void;
	let started: Promise<void>;

	beforeEach(function () {
		sinon = createSandbox();
		notifications = [];
		started = new Promise(resolve => { startNotifications = resolve; });
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake(async (options, task) => {
			const notification = { title: options.title, messages: [] as (string | undefined)[], open: true };
			notifications.push(notification);
			// VS Code may open the notification after the reports that requested it.
			await started;
			await task({ report: ({ message }: { message?: string }) => notification.messages.push(message) }, cancellation.token);
			notification.open = false;
		});
	});

	afterEach(function () {
		sinon.restore();
	});

	async function settle(): Promise<void> {
		await new Promise<void>(resolve => setImmediate(resolve));
	}

	it('shows every report in one notification until it is closed', async function () {
		const progress = new PausableProgressNotification('Updating');
		progress.report('First');
		progress.report('Second');
		startNotifications();
		await settle();
		progress.report('Third');
		progress.close();
		await settle();

		assert.deepStrictEqual(notifications, [{ title: 'Updating', messages: ['Second', 'Third'], open: false }]);
	});

	it('reopens a closed notification on the next report', async function () {
		startNotifications();
		const progress = new PausableProgressNotification('Updating');
		progress.report('Before');
		await settle();
		progress.close();
		await settle();
		progress.report('After');
		await settle();

		assert.deepStrictEqual(notifications, [
			{ title: 'Updating', messages: ['Before'], open: false },
			{ title: 'Updating', messages: ['After'], open: true },
		]);
		progress.close();
		await settle();
		assert.strictEqual(notifications[1].open, false);
	});

	it('does not open a notification until something is reported', async function () {
		startNotifications();
		const progress = new PausableProgressNotification('Updating');
		progress.close();
		await settle();

		assert.deepStrictEqual(notifications, []);
	});
});
