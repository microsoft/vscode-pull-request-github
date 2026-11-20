/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render, wait } from 'react-testing-library';
import { createSandbox, SinonFakeTimers, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { CheckState, GithubItemStateEnum, PullRequestCheckStatus, PullRequestMergeability } from '../../../src/github/interface';
import { MergeResult, PullRequest } from '../../../src/github/views';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Merge, MergeSimple, StatusChecksSection } from '../../components/merge';
import { Root as EditorRoot } from '../app';

function headings(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('.status-heading')).map(heading => heading.textContent ?? '');
}

function check(context: string, state: CheckState, isRequired: boolean): PullRequestCheckStatus {
	return {
		id: context,
		databaseId: undefined,
		url: undefined,
		avatarUrl: undefined,
		state,
		description: null,
		targetUrl: null,
		context,
		workflowName: undefined,
		event: undefined,
		isRequired,
		isCheckRun: false,
	};
}

describe('Merge status and actions', function () {
	let sinon: SinonSandbox;
	let clock: SinonFakeTimers & { tickAsync(milliseconds: number): Promise<number> };

	beforeEach(function () {
		sinon = createSandbox();
		clock = sinon.useFakeTimers() as SinonFakeTimers & { tickAsync(milliseconds: number): Promise<number> };
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('updates an unknown mergeability state from the polling response', async function () {
		const pr = new PullRequestBuilder()
			.mergeable(PullRequestMergeability.Unknown)
			.hasWritePermission(false)
			.build();
		const context = new PRContext(pr);
		const checkMergeability = sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.Mergeable,
		});

		const view = render(
			<PullRequestContext.Provider value={context}>
				<StatusChecksSection pr={pr} isSimple={true} />
			</PullRequestContext.Provider>,
		);

		assert.deepStrictEqual(headings(view.container), ['Checking for conflicts...']);

		await clock.tickAsync(3000);

		assert.deepStrictEqual(headings(view.container), ['No conflicts with main']);
		assert.strictEqual(checkMergeability.calledOnce, true);

		await clock.tickAsync(3000);

		assert.strictEqual(checkMergeability.calledOnce, true);
	});

	it('offers auto-merge once polling finds that it can be enabled', async function () {
		const pr = new PullRequestBuilder()
			.mergeable(PullRequestMergeability.Unknown)
			.allowAutoMerge(false)
			.build();
		const context = new PRContext(pr);
		context.setPR(pr);
		sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.NotMergeable,
			allowAutoMerge: true,
		});

		const view = render(
			<PullRequestContext.Provider value={context}>
				<EditorRoot>{(current: PullRequest) => <StatusChecksSection pr={current} isSimple={false} />}</EditorRoot>
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(view.queryByLabelText('Merge automatically when requirements are met'), null);

		await clock.tickAsync(3000);

		assert(view.getByLabelText('Merge automatically when requirements are met'));
	});

	it('defaults the merge commit title to the head branch with its owner and repository', function () {
		const pr = new PullRequestBuilder()
			.number(1234)
			.head('feature')
			.qualifiedHead('contributor/repo:feature')
			.build();

		const view = render(
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Merge {...pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(view.getByText('Merge Pull Request'));

		assert.strictEqual(view.container.querySelector<HTMLInputElement>('input[name="title"]')?.value, 'Merge pull request #1234 from contributor/repo:feature');
	});
});

describe('Merge dropdown', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('dims the divider with the rest of the button while merging', async function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		let finish!: (result: MergeResult) => void;
		sinon.stub(context, 'merge').returns(new Promise<MergeResult>(resolve => { finish = resolve; }));
		const view = render(
			<PullRequestContext.Provider value={context}>
				<MergeSimple {...pr} />
			</PullRequestContext.Provider>,
		);
		const submit = view.container.querySelector<HTMLInputElement>('.select-control input[type="submit"]')!;
		const divider = view.container.querySelector('.select-control .split')!;

		fireEvent.submit(submit.form!);
		assert.strictEqual(submit.value, 'Merging...');
		assert.strictEqual(submit.disabled, true);
		assert.strictEqual(divider.classList.contains('disabled'), true);

		// The merge was not confirmed, so the pull request stays open.
		finish({ state: GithubItemStateEnum.Open, revertable: false });
		await wait(() => assert.strictEqual(submit.disabled, false));
		assert.strictEqual(divider.classList.contains('disabled'), false);
	});
});

describe('Status checks', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});


	it('lists required checks first, each group ordered by state', function () {
		const pr = new PullRequestBuilder()
			.status(s => s
				.state(CheckState.Failure)
				.statuses([
					check('optional-success', CheckState.Success, false),
					check('required-success', CheckState.Success, true),
					check('optional-failure', CheckState.Failure, false),
					check('required-pending', CheckState.Pending, true),
					check('optional-pending', CheckState.Pending, false),
					check('required-failure', CheckState.Failure, true),
				]))
			.build();

		const view = render(
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<StatusChecksSection pr={pr} isSimple={false} />
			</PullRequestContext.Provider>,
		);

		const listed = Array.from(view.container.querySelectorAll('.status-check-detail-text')).map(e => e.textContent?.trim());
		assert.deepStrictEqual(listed, [
			'required-failure',
			'required-pending',
			'required-success',
			'optional-failure',
			'optional-pending',
			'optional-success',
		]);
	});

	it('shows the logs of each failed check opening until they are open', async function () {
		const failed = (context: string, databaseId: number) => ({ ...check(context, CheckState.Failure, false), isCheckRun: true, databaseId });
		const pr = new PullRequestBuilder()
			.status(s => s.state(CheckState.Failure).statuses([failed('first', 1), failed('second', 2)]))
			.build();
		const context = new PRContext(pr);
		const opened = new Map<string, () => void>();
		sinon.stub(context, 'viewCheckLogs').callsFake(status => new Promise<void>(resolve => opened.set(status.context, resolve)));
		const view = render(
			<PullRequestContext.Provider value={context}>
				<StatusChecksSection pr={pr} isSimple={false} />
			</PullRequestContext.Provider>,
		);
		const [first, second] = view.getAllByTitle('View Logs') as HTMLButtonElement[];

		fireEvent.click(first);
		fireEvent.click(second);
		assert.deepStrictEqual([first.title, first.disabled, second.title, second.disabled], ['Opening Logs...', true, 'Opening Logs...', true]);

		opened.get('first')!();
		await wait(() => assert.strictEqual(first.disabled, false));
		assert.deepStrictEqual([first.title, second.title, second.disabled], ['View Logs', 'Opening Logs...', true]);
	});
});

describe('Merge section', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	function renderSection(pr: PullRequest, context = new PRContext(pr)) {
		return render(
			<PullRequestContext.Provider value={context}>
				<StatusChecksSection pr={pr} isSimple={false} />
			</PullRequestContext.Provider>,
		);
	}

	it('summarizes why merging is blocked before the requirements', function () {
		const pr = new PullRequestBuilder()
			.mergeable(PullRequestMergeability.Behind)
			.reviewRequirement({ count: 1, state: CheckState.Failure, approvals: [], requestedChanges: [] })
			.status(s => s.state(CheckState.Failure).statuses([check('build', CheckState.Failure, true), check('lint', CheckState.Success, false)]))
			.build();

		const view = renderSection(pr);

		const summary = view.container.querySelector('#status-checks > .merge-summary.blocked');
		assert.strictEqual(summary, view.container.querySelector('#status-checks')?.firstElementChild);
		assert.strictEqual(summary?.querySelector('.merge-summary-title')?.textContent, 'Merging is blocked');
		assert.strictEqual(summary?.querySelector('.merge-summary-detail')?.textContent, 'Review required · 1 check failed · Branch out of date');
		assert.deepStrictEqual(headings(view.container), ['Review required', 'Some checks failed', 'Branch is out of date']);
		assert.strictEqual(view.container.querySelector('.passing-summary'), null, 'nothing is collapsed while merging is blocked');
	});

	it('collapses the requirements that are met once the pull request is ready, and shows them on request', function () {
		const pr = new PullRequestBuilder()
			.reviewRequirement({ count: 1, state: CheckState.Success, approvals: ['reviewer'], requestedChanges: [] })
			.status(s => s.state(CheckState.Success).statuses([check('build', CheckState.Success, true), check('docs', CheckState.Neutral, false)]))
			.build();

		const view = renderSection(pr);

		assert.strictEqual(view.container.querySelector('.merge-summary-title')?.textContent, 'Ready to merge');
		assert.deepStrictEqual(Array.from(view.container.querySelectorAll('.passing-label')).map(label => label.textContent),
			['Approved', '1 check passed, 1 skipped', 'No conflicts with main']);
		const content = view.container.querySelector('#passing-requirements-content')!;
		assert.strictEqual(content.hasAttribute('hidden'), true);
		assert.deepStrictEqual(headings(content as HTMLElement), ['Approved', 'All checks passed', 'No conflicts with main']);
		assert.strictEqual(view.container.querySelectorAll('.status-heading').length, 3, 'each requirement is shown once');

		fireEvent.click(view.getByText('Approved', { selector: '.passing-label' }));

		assert.strictEqual(content.hasAttribute('hidden'), false);
		assert.strictEqual(view.getByLabelText('Hide requirements that are met').getAttribute('aria-expanded'), 'true');
	});

	it('shows the check counts only while the list of checks is hidden', function () {
		const pr = new PullRequestBuilder()
			.status(s => s.state(CheckState.Failure).statuses([check('build', CheckState.Failure, true), check('lint', CheckState.Success, false)]))
			.build();

		const view = renderSection(pr);

		assert(view.container.querySelector('.status-check'), 'a failed check shows the list');
		assert.strictEqual(view.container.querySelector('.check-counts'), null);

		fireEvent.click(view.getByLabelText('Hide status checks'));

		assert.strictEqual(view.container.querySelector('.status-check'), null);
		assert.strictEqual(view.container.querySelector('.check-counts')?.textContent, '1 failing1 passing');
	});

	it('shows a branch that is behind its base in one row with the action that updates it', function () {
		const pr = new PullRequestBuilder().canUpdateBranch(true).build();
		const context = new PRContext(pr);
		const updateBranch = sinon.stub(context, 'updateBranch').resolves();

		const view = renderSection(pr, context);

		assert.deepStrictEqual(headings(view.container), ['Branch is behind main']);
		fireEvent.click(view.getByText('Update with Merge Commit'));
		assert(updateBranch.calledOnce);
	});

	it('merges with the method that is chosen from the merge button menu', function () {
		const pr = new PullRequestBuilder()
			.number(1234)
			.defaultMergeMethod('squash')
			.mergeMethodsAvailability({ merge: true, squash: true, rebase: false })
			.build();
		const context = new PRContext(pr);

		const view = render(
			<PullRequestContext.Provider value={context}>
				<Merge {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(view.getByText('Squash and Merge', { selector: 'button' }));
		const menu = JSON.parse(view.getByTitle('Choose Merge Method').getAttribute('data-vscode-context')!);
		assert.deepStrictEqual(
			[menu['github:mergeMenu'], menu['github:mergeMenuMerge'], menu['github:mergeMenuSquash'], menu['github:mergeMenuRebase']],
			[true, true, true, false],
		);

		act(() => context.handleMessage({ command: 'pr.select-merge-method', method: 'merge' }));

		assert.strictEqual(view.container.querySelector<HTMLInputElement>('input[name="title"]')?.value, 'Merge pull request #1234 from my-fork/name:my-branch');
		assert(view.getByText('Create Merge Commit'));
	});
});