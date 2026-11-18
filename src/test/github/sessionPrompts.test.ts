/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitHubServerType } from '../../common/authentication';
import { DiffSide, IComment, IReviewThread, SubjectType } from '../../common/comment';
import { commands } from '../../common/executeCommands';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { AccountType, CheckState, IAccount, PullRequestCheckStatus } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { addressCommentsInSession, fixChecksInSession } from '../../github/sessionPrompts';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

interface ChatOpenOptions {
	query: string;
	isPartialQuery: boolean;
	attachFiles: (vscode.Uri | { uri: vscode.Uri; range: vscode.Range })[];
}

describe('Session prompts', function () {
	let sinon: SinonSandbox;
	let pullRequest: PullRequestModel;
	let gitHubRepository: MockGitHubRepository;
	let executeCommand: SinonStub;
	let showInformationMessage: SinonStub;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, new MockExtensionContext());
		const url = 'https://github.com/owner/name.git';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		pullRequest = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1234).build(), gitHubRepository));
		executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
		showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
	});

	afterEach(function () {
		sinon.restore();
	});

	function chatOpenOptions(): ChatOpenOptions {
		assert(executeCommand.calledOnce);
		assert.strictEqual(executeCommand.firstCall.args[0], commands.OPEN_CHAT);
		return executeCommand.firstCall.args[1];
	}

	describe('fixChecksInSession', function () {
		// The logs are written to disk through vscode.workspace.fs, which is slow in the extension host shared by all the tests,
		// so these can exceed the default timeout that CI runs the tests with.
		this.timeout(10000);
		let storage: string;

		beforeEach(function () {
			storage = mkdtempSync(path.join(os.tmpdir(), 'session-prompts-'));
		});

		afterEach(function () {
			rmSync(storage, { recursive: true, force: true });
		});

		function check(overrides: Partial<PullRequestCheckStatus>): PullRequestCheckStatus {
			return {
				id: overrides.context ?? 'check', state: CheckState.Failure, context: 'check', description: null, targetUrl: null,
				workflowName: undefined, event: undefined, url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: false, databaseId: undefined,
				...overrides,
			};
		}

		it('attaches the logs of the failed check runs to a prompt that lists the failed checks, replacing earlier logs', async function () {
			const staleLog = path.join(storage, 'checkLogs', 'owner.name.1234', 'stale.log');
			mkdirSync(path.dirname(staleLog), { recursive: true });
			writeFileSync(staleLog, 'stale');
			sinon.stub(pullRequest, 'getStatusChecks').resolves([{
				state: CheckState.Failure,
				statuses: [
					check({ context: 'build', workflowName: 'CI', isCheckRun: true, databaseId: 7, isRequired: true, description: 'Process completed with exit code 1.', targetUrl: 'https://github.com/owner/name/actions/runs/1/job/7' }),
					check({ context: 'license/cla', description: 'Sign the CLA.' }),
					check({ context: 'lint', state: CheckState.Success, isCheckRun: true, databaseId: 8 }),
				],
			}, null]);
			sinon.stub(gitHubRepository, 'getCheckRunLogs').withArgs(7).resolves('error TS2304: Cannot find name');

			assert.strictEqual(await fixChecksInSession(pullRequest, vscode.Uri.file(storage)), true);

			const { query, isPartialQuery, attachFiles } = chatOpenOptions();
			assert.strictEqual(isPartialQuery, true);
			assert(query.includes('owner/name#1234'), query);
			assert(query.includes('- CI / build (required): Process completed with exit code 1.'), query);
			assert(query.includes('Details: https://github.com/owner/name/actions/runs/1/job/7'), query);
			assert(query.includes('Logs: CI-build-7.log'), query);
			assert(query.includes('- license/cla: Sign the CLA.'), query);
			assert(!query.includes('lint'), query);
			assert.strictEqual(attachFiles.length, 1);
			const log = attachFiles[0];
			assert(log instanceof vscode.Uri);
			assert.strictEqual(path.basename(log.fsPath), 'CI-build-7.log');
			assert.strictEqual(readFileSync(log.fsPath, 'utf8'), 'error TS2304: Cannot find name');
			assert(!existsSync(staleLog));
		});

		it('deletes the logs of other fixes from a day or more ago', async function () {
			const hour = 60 * 60 * 1000;
			for (const [name, age] of [['other.repo.1', 25 * hour], ['other.repo.2', hour]] as const) {
				const folder = path.join(storage, 'checkLogs', name);
				mkdirSync(folder, { recursive: true });
				writeFileSync(path.join(folder, 'check.log'), 'logs');
				const written = new Date(Date.now() - age);
				utimesSync(folder, written, written);
			}
			sinon.stub(pullRequest, 'getStatusChecks').resolves([{ state: CheckState.Failure, statuses: [check({ context: 'build', isCheckRun: true, databaseId: 7 })] }, null]);
			sinon.stub(gitHubRepository, 'getCheckRunLogs').resolves('logs');

			await fixChecksInSession(pullRequest, vscode.Uri.file(storage));

			assert.deepStrictEqual(readdirSync(path.join(storage, 'checkLogs')).sort(), ['other.repo.2', 'owner.name.1234']);
		});

		it('does not open chat without failed checks', async function () {
			sinon.stub(pullRequest, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [check({ state: CheckState.Success })] }, null]);

			assert.strictEqual(await fixChecksInSession(pullRequest, vscode.Uri.file(storage)), false);
			assert(executeCommand.notCalled);
			assert(showInformationMessage.calledOnce);
		});
	});

	describe('addressCommentsInSession', function () {
		function account(login: string): IAccount {
			return { login, id: login, url: `https://github.com/${login}`, accountType: AccountType.User };
		}

		function thread(id: string, overrides: Partial<IReviewThread>, comments: Partial<IComment>[] = [{}]): IReviewThread {
			return {
				id, isResolved: false, viewerCanResolve: true, viewerCanUnresolve: false, path: `src/${id}.ts`, diffSide: DiffSide.RIGHT,
				startLine: 3, endLine: 5, originalStartLine: 1, originalEndLine: 2, isOutdated: false, subjectType: SubjectType.LINE,
				comments: comments.map((comment, index) => ({
					id: index, url: '', diffHunk: '', body: `Comment on ${id}`, createdAt: '2019-01-01T10:00:00Z', graphNodeId: `${id}-${index}`,
					htmlUrl: `https://github.com/owner/name/pull/1234#discussion_${id}`, user: account('reviewer'), ...comment,
				})),
				...overrides,
			};
		}

		beforeEach(function () {
			sinon.stub(pullRequest, 'getReviewThreads').resolves([
				thread('lines', {}, [{ body: 'Rename this.\nIt is unclear.' }, { body: 'Agreed.', user: account('author') }, { body: 'Draft reply', isDraft: true }]),
				thread('resolved', { isResolved: true }),
				thread('draft', {}, [{ isDraft: true }]),
				thread('outdated', { isOutdated: true, startLine: undefined, endLine: undefined }),
				thread('base', { diffSide: DiffSide.LEFT, startLine: 4, endLine: 4 }),
				thread('file', { subjectType: SubjectType.FILE }),
			]);
		});

		it('lists the posted unresolved comments with the lines they comment on attached when the pull request is checked out', async function () {
			const checkoutRoot = vscode.Uri.file(path.join(os.tmpdir(), 'checkout'));

			assert.strictEqual(await addressCommentsInSession(pullRequest, checkoutRoot), true);

			const { query, isPartialQuery, attachFiles } = chatOpenOptions();
			assert.strictEqual(isPartialQuery, true);
			assert(query.includes('owner/name#1234'), query);
			assert(query.includes([
				'- src/lines.ts:3-5',
				'  > @reviewer: Rename this.',
				'  > It is unclear.',
				'  > @author: Agreed.',
				'  https://github.com/owner/name/pull/1234#discussion_lines',
			].join('\n')), query);
			assert(query.includes('- src/outdated.ts:1-2 (outdated)'), query);
			assert(query.includes('- src/base.ts:4 (base branch)'), query);
			assert(query.includes('- src/file.ts (file)'), query);
			for (const excluded of ['Draft reply', 'src/resolved.ts', 'src/draft.ts']) {
				assert(!query.includes(excluded), excluded);
			}
			assert.deepStrictEqual(attachFiles.map(attachment => attachment instanceof vscode.Uri
				? { path: attachment.fsPath }
				: { path: attachment.uri.fsPath, lines: [attachment.range.start.line, attachment.range.end.line] }), [
				{ path: path.join(checkoutRoot.fsPath, 'src', 'lines.ts'), lines: [2, 4] },
				{ path: path.join(checkoutRoot.fsPath, 'src', 'file.ts') },
			]);
		});

		it('attaches no files when the pull request is not checked out', async function () {
			assert.strictEqual(await addressCommentsInSession(pullRequest, undefined), true);

			assert.deepStrictEqual(chatOpenOptions().attachFiles, []);
		});
	});
});
