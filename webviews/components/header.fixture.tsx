/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Header, HeaderPreview } from './header';
import { EventType } from '../../src/common/timelineEvent';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { createAccount, createPullRequest, createStack } from '../fixtures/data';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup } from '../fixtures/fixtureUtils';

function headerFixture(overrides: () => Partial<PullRequest>, rename = false, width = 900) {
	return defineComponentFixture({
		width,
		createPullRequest: () => createPullRequest(overrides()),
		render: pr => <div id="title" className="title"><div className="details"><Header {...pr} /></div></div>,
		prepare: rename ? clickFixtureElement('button[title="Rename"]') : undefined,
	});
}

export default defineFixtureGroup({ path: 'Components/Header' }, {
	Open: headerFixture(() => ({})),
	Draft: headerFixture(() => ({ isDraft: true })),
	Merged: headerFixture(() => ({ state: GithubItemStateEnum.Merged })),
	Closed: headerFixture(() => ({ state: GithubItemStateEnum.Closed })),
	Stacked: headerFixture(() => ({ stack: createStack() })),
	CheckoutAvailable: headerFixture(() => ({ isCurrentlyCheckedOut: false })),
	Busy: headerFixture(() => ({ busy: true })),
	Rename: headerFixture(() => ({}), true),
	ReadOnly: headerFixture(() => ({ canEdit: false, hasWritePermission: false })),
	LongTitleNarrow: headerFixture(() => ({
		title: 'Preserve keyboard focus when refreshing a pull request with a long branch name',
		titleHTML: 'Preserve keyboard focus when refreshing a pull request with a long branch name',
		head: 'feature/preserve-keyboard-focus-after-background-refresh',
	}), false, 380),
	IssueNotPlanned: headerFixture(() => ({ isIssue: true, state: GithubItemStateEnum.Closed, stateReason: 'NOT_PLANNED' })),
	CopilotWorking: headerFixture(() => ({
		events: [{
			id: 'agent-start', event: EventType.CopilotStarted, createdAt: '2025-01-15T11:30:00Z',
			onBehalfOf: createAccount(), sessionLink: { id: 1, host: 'github.com', owner: 'octocat', repo: 'component-explorer', pullNumber: 102, sessionIndex: 0 },
		}],
	})),
	Preview: defineComponentFixture({
		width: 900,
		render: pr => <div id="title" className="title"><div className="details"><HeaderPreview {...pr} /></div></div>,
	}),
});
