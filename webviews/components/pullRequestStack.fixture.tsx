/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PrActions } from './merge';
import { StackSection } from './pullRequestStack';
import { GithubItemStateEnum, PullRequestMergeability } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { createPullRequest, createStack } from '../fixtures/data';
import { defaultCommand, defineComponentFixture, defineFixtureGroup, defineThemeVariants, FixtureCommandHandler, FixtureTheme } from '../fixtures/fixtureUtils';

const renderStack = (pr: PullRequest) => <div id="status-checks">
	<StackSection pr={pr} />
	<PrActions pr={pr} isSimple={false} />
</div>;

function stackFixture(create: () => PullRequest, { handleCommand, action, defaultTheme = FixtureTheme.Dark }: {
	handleCommand?: FixtureCommandHandler;
	action?: 'Update stack' | 'Unstack all';
	defaultTheme?: FixtureTheme;
} = {}) {
	return defineComponentFixture({
		width: 720,
		defaultTheme,
		createPullRequest: create,
		render: renderStack,
		handleCommand,
		prepare: action ? async container => {
			const button = [...container.querySelectorAll('button')].find(button => button.textContent === action);
			if (!button) {
				throw new Error(`Missing fixture action: ${action}`);
			}
			button.click();
			await new Promise<void>(resolve => container.ownerDocument.defaultView!.setTimeout(resolve, 0));
		} : undefined,
	});
}

function readyStack(): PullRequest {
	return createPullRequest({ stack: createStack(), canUpdateStack: true });
}

const actionFailure: FixtureCommandHandler = (request, pr) => {
	if (request.command === 'pr.update-stack' || request.command === 'pr.unstack-all') {
		throw new Error('Push rejected by branch protection');
	}
	return defaultCommand(request, pr);
};

const actionPending: FixtureCommandHandler = (request, pr) => {
	if (request.command === 'pr.update-stack' || request.command === 'pr.unstack-all') {
		return new Promise<never>(() => {});
	}
	return defaultCommand(request, pr);
};

export default defineFixtureGroup({ path: 'Components/Pull request stack' }, {
	Ready: defineThemeVariants(defaultTheme => stackFixture(readyStack, { defaultTheme })),
	DraftConflictBehind: defineThemeVariants(defaultTheme => stackFixture(() => {
		const stack = createStack();
		stack.pullRequests[0].mergeable = PullRequestMergeability.Behind;
		stack.pullRequests[1].mergeable = PullRequestMergeability.Conflict;
		stack.pullRequests[2].isDraft = true;
		return createPullRequest({ stack, mergeable: PullRequestMergeability.Conflict });
	}, { defaultTheme })),
	ReadOnly: stackFixture(() => createPullRequest({ stack: createStack(), hasWritePermission: false, canEdit: false })),
	Loading: stackFixture(() => createPullRequest({ stackLoaded: false })),
	LoadFailed: stackFixture(() => createPullRequest({ stackLoadError: true })),
	MergedAndClosed: stackFixture(() => {
		const stack = createStack();
		stack.pullRequests[0].state = GithubItemStateEnum.Merged;
		stack.pullRequests[2].state = GithubItemStateEnum.Closed;
		return createPullRequest({ stack });
	}),
	UpdateFailed: stackFixture(readyStack, { handleCommand: actionFailure, action: 'Update stack' }),
	UpdatePending: stackFixture(readyStack, { handleCommand: actionPending, action: 'Update stack' }),
	UnstackFailed: stackFixture(readyStack, { handleCommand: actionFailure, action: 'Unstack all' }),
	UnstackPending: stackFixture(readyStack, { handleCommand: actionPending, action: 'Unstack all' }),
	MergePending: stackFixture(() => createPullRequest({ stack: createStack(), stackMergeStatus: 'pending' })),
});
