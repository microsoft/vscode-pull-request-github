/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import MarkdownIt from 'markdown-it';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { DiffSide, IReviewThread, SubjectType } from '../../common/comment';
import { GitChangeType } from '../../common/file';
import { toPRUri } from '../../common/uri';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { extendMarkdownIt, MarkdownPreviewComments } from '../../view/markdownPreviewComments';
import { MarkdownPreviewCommentInfo } from '../../view/reviewCommentController';
import { ReviewsManager } from '../../view/reviewsManager';

const DATA_ELEMENT_PATTERN = /<div id="github-pr-markdown-preview-comments" hidden data-state="([^"]*)"><\/div>/;

function readPreviewData(html: string): { [uri: string]: MarkdownPreviewCommentInfo & { commentUri: string } } | undefined {
	const match = DATA_ELEMENT_PATTERN.exec(html);
	return match ? JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) : undefined;
}

function createThread(overrides: Partial<IReviewThread>): IReviewThread {
	return {
		id: 'thread',
		isResolved: false,
		viewerCanResolve: true,
		viewerCanUnresolve: true,
		path: 'docs/guide.md',
		diffSide: DiffSide.RIGHT,
		startLine: 3,
		endLine: 4,
		originalStartLine: 3,
		originalEndLine: 4,
		isOutdated: false,
		comments: [{} as IReviewThread['comments'][0]],
		subjectType: SubjectType.LINE,
		...overrides,
	};
}

describe('MarkdownPreviewComments', function () {
	let sandbox: SinonSandbox;
	let previewComments: MarkdownPreviewComments | undefined;

	beforeEach(function () {
		sandbox = createSandbox();
		sandbox.stub(vscode.commands, 'executeCommand').resolves();
		commentingRangesProvided = new vscode.EventEmitter<vscode.Uri>();
	});

	afterEach(function () {
		previewComments?.dispose();
		previewComments = undefined;
		sandbox.restore();
	});

	interface RepositoryFixture {
		root: string;
		workspaceInfo?: MarkdownPreviewCommentInfo;
		pullRequestRanges?: unknown;
		pullRequestThreads?: IReviewThread[];
	}

	let fireCommentThreadsChanged: () => void;
	let commentingRangesProvided: vscode.EventEmitter<vscode.Uri>;

	function createPreviewComments(...repositories: RepositoryFixture[]): MarkdownPreviewComments {
		const reviewsManager = {
			reviewManagers: repositories.filter(repository => repository.workspaceInfo).map(repository => ({
				repository: { rootUri: vscode.Uri.file(repository.root) },
				reviewCommentController: {
					getMarkdownPreviewCommentInfo: async () => repository.workspaceInfo,
					onDidProvideCommentingRanges: commentingRangesProvided.event,
				},
			})),
			onDidChangeCommentThreads: (listener: () => void) => {
				fireCommentThreadsChanged = listener;
				return { dispose: () => { } };
			},
		} as unknown as ReviewsManager;
		const reposManager = {
			folderManagers: repositories.map(repository => {
				const pullRequest = {
					reviewThreadsCache: repository.pullRequestThreads ?? [],
					onDidChangeReviewThreads: () => ({ dispose: () => { } }),
				};
				return {
					repository: { rootUri: vscode.Uri.file(repository.root) },
					gitHubRepositories: [{
						remote: { remoteName: 'origin' },
						getExistingPullRequestModel: (prNumber: number) => prNumber === 7 ? pullRequest : undefined,
						commentsHandler: {
							getCommentingRanges: async () => repository.pullRequestRanges,
							onDidProvideCommentingRanges: commentingRangesProvided.event,
						},
					}],
				};
			}),
		} as unknown as RepositoriesManager;
		previewComments = new MarkdownPreviewComments(reviewsManager, reposManager);
		return previewComments;
	}

	function prUri(isBase: boolean, root: string = '/repo'): vscode.Uri {
		return toPRUri(vscode.Uri.file(`${root}/docs/guide.md`), { number: 7, githubRepository: { remote: { remoteName: 'origin' } } } as unknown as PullRequestModel, 'base', 'head', 'docs/guide.md', isBase, GitChangeType.MODIFY);
	}

	it('marks the last line of each block', function () {
		const md = extendMarkdownIt(new MarkdownIt());
		const html = md.render('# Title\n\nFirst line\nsecond line\n\n- item\n');

		assert.ok(html.includes('<h1 data-pr-end-line="0">'), html);
		assert.ok(html.includes('<p data-pr-end-line="3">'), html);
		assert.ok(html.includes('<li data-pr-end-line="5">'), html);
	});

	it('does not add comment information for documents outside of a pull request', async function () {
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: { commentingRanges: [{ start: 0, end: 1 }], threads: [] } });
		const document = vscode.Uri.file('/elsewhere/README.md');
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves({ uri: document } as vscode.TextDocument);
		const md = extendMarkdownIt(new MarkdownIt());

		md.render('Some text\n', { currentDocument: document });
		await previewComments['update'](document);

		assert.strictEqual(readPreviewData(md.render('Some text\n', { currentDocument: document })), undefined);
	});

	it('adds the comment information of a checked out pull request file after it is computed', async function () {
		const info = { commentingRanges: [{ start: 2, end: 5 }], threads: [{ start: 3, end: 4, commentCount: 2, resolved: false }] };
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: info });
		const document = vscode.Uri.file('/repo/docs/guide.md');
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves({ uri: document } as vscode.TextDocument);
		const md = extendMarkdownIt(new MarkdownIt());

		assert.strictEqual(readPreviewData(md.render('text\n', { currentDocument: document })), undefined);
		await previewComments['update'](document);
		const data = readPreviewData(md.render('text\n', { currentDocument: document }));

		assert.deepStrictEqual(data?.[document.toString()].commentingRanges, info.commentingRanges);
		assert.deepStrictEqual(data?.[document.toString()].threads, info.threads);
		assert.match(data![document.toString()].commentUri, /\/comment-on-markdown-preview\?document=1$/);
		assert.ok((vscode.commands.executeCommand as SinonStub).calledWith('markdown.preview.refresh'));
	});

	it('gets commenting ranges and threads of each side of a pull request that is not checked out', async function () {
		const previewComments = createPreviewComments({
			root: '/repo',
			// The registered commenting range providers return an object with the ranges.
			pullRequestRanges: { ranges: [new vscode.Range(1, 0, 6, 0)], enableFileComments: true },
			pullRequestThreads: [
				createThread({ id: 'right', startLine: 3, endLine: 4, comments: [{}, {}] as IReviewThread['comments'] }),
				createThread({ id: 'left', diffSide: DiffSide.LEFT, startLine: 2, endLine: 2, isResolved: true }),
				createThread({ id: 'file', subjectType: SubjectType.FILE }),
				createThread({ id: 'other', path: 'docs/other.md' }),
			],
		});

		const modified = await previewComments['getInfo']({ uri: prUri(false) } as vscode.TextDocument);
		const original = await previewComments['getInfo']({ uri: prUri(true) } as vscode.TextDocument);

		assert.deepStrictEqual(modified, {
			commentingRanges: [{ start: 1, end: 6 }],
			threads: [{ start: 2, end: 3, commentCount: 2, resolved: false }],
		});
		assert.deepStrictEqual(original?.threads, [{ start: 1, end: 1, commentCount: 1, resolved: true }]);
	});

	it('adds the comment information of open documents when the rendered document is not known', async function () {
		// The rendered diff renders a copy of the text when it highlights changes within lines.
		const info = { commentingRanges: [{ start: 0, end: 1 }], threads: [] };
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: info });
		const document = vscode.Uri.file('/repo/docs/guide.md');
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves({ uri: document } as vscode.TextDocument);
		sandbox.stub(vscode.workspace, 'textDocuments').get(() => [
			{ uri: document, languageId: 'markdown' },
			{ uri: vscode.Uri.file('/repo/src/index.ts'), languageId: 'typescript' },
		]);
		const md = extendMarkdownIt(new MarkdownIt());

		md.render('text\n');
		await previewComments['update'](document);
		const data = readPreviewData(md.render('text\n'));

		assert.deepStrictEqual(Object.keys(data ?? {}), [document.toString()]);
	});

	it('opens the comment widget on the lines of a block, clamped to the diff hunk', async function () {
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: { commentingRanges: [{ start: 4, end: 10 }], threads: [] } });
		const document = vscode.Uri.file('/repo/docs/guide.md');
		const textDocument = {
			uri: document,
			lineCount: 20,
			lineAt: (line: number) => ({ range: new vscode.Range(line, 0, line, 12) }),
		} as unknown as vscode.TextDocument;
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves(textDocument);
		const revealRange = sandbox.spy();
		const showTextDocument = sandbox.stub(vscode.window, 'showTextDocument').resolves({ revealRange } as unknown as vscode.TextEditor);
		sandbox.stub(vscode.window, 'visibleTextEditors').get(() => [{ document: textDocument, viewColumn: vscode.ViewColumn.Two }]);
		previewComments['getCommentUri'](document);

		await previewComments.commentOnLines('1', 2, 6);

		assert.strictEqual(showTextDocument.firstCall.args[0], textDocument);
		assert.ok((vscode.commands.executeCommand as SinonStub).calledWith('workbench.action.addComment', {
			range: { startLineNumber: 5, startColumn: 1, endLineNumber: 7, endColumn: 13 },
		}));
	});

	it('does not open the comment widget for lines outside of the diff', async function () {
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: { commentingRanges: [{ start: 4, end: 10 }], threads: [] } });
		const document = vscode.Uri.file('/repo/docs/guide.md');
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves({ uri: document, lineCount: 20 } as vscode.TextDocument);
		const showWarningMessage = sandbox.stub(vscode.window, 'showWarningMessage').resolves();
		previewComments['getCommentUri'](document);

		await previewComments.commentOnLines('1', 12, 14);

		assert.strictEqual(showWarningMessage.callCount, 1);
		assert.ok(!(vscode.commands.executeCommand as SinonStub).calledWith('workbench.action.addComment'));
	});

	it('uses the repository that contains a pull request file when repositories have the same remote name and pull request number', async function () {
		const thread = createThread({ startLine: 5, endLine: 5 });
		const previewComments = createPreviewComments(
			{ root: '/repo-a', pullRequestRanges: [new vscode.Range(0, 0, 1, 0)], pullRequestThreads: [] },
			{ root: '/repo-b', pullRequestRanges: [new vscode.Range(2, 0, 9, 0)], pullRequestThreads: [thread] },
		);

		const info = await previewComments['getInfo']({ uri: prUri(false, '/repo-b') } as vscode.TextDocument);

		assert.deepStrictEqual(info, {
			commentingRanges: [{ start: 2, end: 9 }],
			threads: [{ start: 4, end: 4, commentCount: 1, resolved: false }],
		});
	});

	it('uses the deepest repository for files of nested repositories', async function () {
		const nestedInfo = { commentingRanges: [{ start: 3, end: 3 }], threads: [] };
		const previewComments = createPreviewComments(
			{ root: '/repo', workspaceInfo: { commentingRanges: [{ start: 0, end: 0 }], threads: [] } },
			{ root: '/repo/nested', workspaceInfo: nestedInfo },
		);

		const info = await previewComments['getInfo']({ uri: vscode.Uri.file('/repo/nested/README.md') } as vscode.TextDocument);

		assert.deepStrictEqual(info, nestedInfo);
	});

	it('only updates open documents when comment threads change', async function () {
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: { commentingRanges: [], threads: [] } });
		const open = vscode.Uri.file('/repo/docs/open.md');
		const closed = vscode.Uri.file('/repo/docs/closed.md');
		const md = extendMarkdownIt(new MarkdownIt());
		md.render('text\n', { currentDocument: open });
		md.render('text\n', { currentDocument: closed });
		sandbox.stub(vscode.workspace, 'textDocuments').get(() => [{ uri: open, languageId: 'markdown' }]);
		const scheduleUpdate = sandbox.spy(previewComments as any, 'scheduleUpdate');

		fireCommentThreadsChanged();

		assert.deepStrictEqual(scheduleUpdate.getCalls().map(call => call.args[0].toString()), [open.toString()]);
	});

	it('waits for the commenting ranges of a newly opened editor before opening the comment widget', async function () {
		const previewComments = createPreviewComments({ root: '/repo', workspaceInfo: { commentingRanges: [{ start: 0, end: 10 }], threads: [] } });
		const document = vscode.Uri.file('/repo/docs/guide.md');
		const textDocument = {
			uri: document,
			lineCount: 20,
			lineAt: (line: number) => ({ range: new vscode.Range(line, 0, line, 12) }),
		} as unknown as vscode.TextDocument;
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves(textDocument);
		sandbox.stub(vscode.window, 'showTextDocument').resolves({ revealRange: () => { } } as unknown as vscode.TextEditor);
		sandbox.stub(vscode.window, 'visibleTextEditors').get(() => []);
		const executeCommand = vscode.commands.executeCommand as SinonStub;
		previewComments['getCommentUri'](document);

		const commented = previewComments.commentOnLines('1', 2, 3);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(!executeCommand.calledWith('workbench.action.addComment'), 'adding a comment fails until the editor has its commenting ranges');

		commentingRangesProvided.fire(vscode.Uri.file('/repo/docs/other.md'));
		commentingRangesProvided.fire(document);
		await commented;

		assert.ok(executeCommand.calledWith('workbench.action.addComment'));
	});
});

