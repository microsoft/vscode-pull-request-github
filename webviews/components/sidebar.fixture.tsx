/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Reviewer } from './reviewer';
import Sidebar, { CollapsibleSidebar, SidebarPreview } from './sidebar';
import { AccountType, ReviewState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { avatarUrl, createAccount, createPullRequest } from '../fixtures/data';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup, defineThemeVariants, FixtureTheme } from '../fixtures/fixtureUtils';

function populatedSidebar(): Partial<PullRequest> {
	return {
		reviewers: [
			{ reviewer: createAccount('alice'), state: 'APPROVED' },
			{ reviewer: createAccount('bob'), state: 'CHANGES_REQUESTED' },
			{ reviewer: createAccount('carol'), state: 'REQUESTED' },
		],
		assignees: [createAccount('octocat'), createAccount('maintainer')],
		labels: [
			{ name: 'bug', displayName: 'bug', color: 'd73a4a' },
			{ name: 'accessibility', displayName: 'accessibility', color: '7057ff' },
		],
		projectItems: [{ id: 'item-1', project: { id: 'project-1', title: 'Accessibility improvements' } }],
		milestone: { id: 'milestone-1', number: 1, title: 'January release', createdAt: '2025-01-01T00:00:00Z', dueOn: '2025-01-31T00:00:00Z' },
	};
}

const renderSidebar = (pr: PullRequest) => <Sidebar {...pr} />;
const renderCollapsibleSidebar = (pr: PullRequest) => <CollapsibleSidebar {...pr} />;

function sidebarFixture(overrides: () => Partial<PullRequest>, { collapsed = false, expanded = false, defaultTheme = FixtureTheme.Dark }: {
	collapsed?: boolean;
	expanded?: boolean;
	defaultTheme?: FixtureTheme;
} = {}) {
	return defineComponentFixture({
		width: collapsed ? 380 : 400,
		defaultTheme,
		createPullRequest: () => createPullRequest(overrides()),
		render: collapsed ? renderCollapsibleSidebar : renderSidebar,
		prepare: expanded ? clickFixtureElement('.collapsible-label-see-more') : undefined,
	});
}

function reviewerFixture(state: ReviewState['state'], bot = false) {
	return defineComponentFixture({
		width: 400,
		render: () => <Reviewer reviewState={{ state, reviewer: createAccount(bot ? 'review-bot' : 'reviewer', { accountType: bot ? AccountType.Bot : AccountType.User }) }} />,
	});
}

const sidebar = defineFixtureGroup({
	Empty: sidebarFixture(() => ({ labels: [], assignees: [], projectItems: [] })),
	Populated: defineThemeVariants(defaultTheme => sidebarFixture(populatedSidebar, { defaultTheme })),
	ReadOnly: sidebarFixture(() => ({ ...populatedSidebar(), hasWritePermission: false, canEdit: false, isAuthor: false })),
	CopilotActions: sidebarFixture(() => ({ canAssignCopilot: true, canRequestCopilotReview: true })),
	Issue: sidebarFixture(() => ({ ...populatedSidebar(), isIssue: true })),
	Collapsed: sidebarFixture(populatedSidebar, { collapsed: true }),
	Expanded: defineThemeVariants(defaultTheme => sidebarFixture(populatedSidebar, { collapsed: true, expanded: true, defaultTheme })),
	Loading: defineComponentFixture({ width: 400, render: () => <SidebarPreview isSingleColumnLayout={false} isIssue={false} /> }),
});

const reviewers = defineFixtureGroup({
	Requested: reviewerFixture('REQUESTED'),
	Approved: reviewerFixture('APPROVED'),
	ChangesRequested: reviewerFixture('CHANGES_REQUESTED'),
	Commented: reviewerFixture('COMMENTED'),
	Bot: reviewerFixture('APPROVED', true),
	Team: defineComponentFixture({
		width: 400,
		render: () => <Reviewer reviewState={{ state: 'REQUESTED', reviewer: {
			id: 'team-platform', name: 'Platform maintainers', slug: 'platform', org: 'octocat',
			url: 'https://github.com/orgs/octocat/teams/platform', avatarUrl,
		} }} />,
	}),
});

export default defineFixtureGroup({ path: 'Components/Sidebar' }, {
	Overview: sidebar,
	Reviewers: reviewers,
});
