/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import type { IComment, IReviewThread } from '../../common/comment';
import { ALL_CHANGES, DiffRangeInputs, diffRangeKey, isUnavailableDiffRange, resolveDiffRangePreset, ResolvedDiffRange, shortSha } from '../../github/diffRange';

const HEAD = 'd2a9384d5b1c6e2f3a4b5c6d7e8f9a0b1c2d3e4f';
const REVIEWED = '5ad2698537f1e2d3c4b5a6978877665544332211';
const OLDER = 'a5e85f91a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const OLDEST = '53b0721e0f1e2d3c4b5a69788776655443322110';
const VIEWER = 'viewer';
const OTHER = 'someone-else';

function comment(options: { login?: string; originalCommitId?: string; createdAt: string; path?: string }): IComment {
	return {
		user: options.login ? { login: options.login, url: '', id: options.login } : undefined,
		originalCommitId: options.originalCommitId,
		createdAt: options.createdAt,
		path: options.path,
	} as IComment;
}

function thread(options: { resolved?: boolean; comments: IComment[] }): IReviewThread {
	return {
		isResolved: !!options.resolved,
		comments: options.comments,
	} as IReviewThread;
}

function inputs(overrides: Partial<DiffRangeInputs> = {}): DiffRangeInputs {
	return {
		threads: [],
		latestReviewSha: undefined,
		viewerLogin: VIEWER,
		commits: [],
		headSha: HEAD,
		...overrides,
	};
}

function resolved(inputsToUse: DiffRangeInputs, preset: 'sinceLastReview' | 'sinceLastComment' | 'sinceEarliestUnresolvedThread'): ResolvedDiffRange {
	const resolution = resolveDiffRangePreset(preset, inputsToUse);
	assert.ok(!isUnavailableDiffRange(resolution), `Expected ${preset} to resolve, but it was unavailable: ${(resolution as { unavailable: string }).unavailable}`);
	return resolution as ResolvedDiffRange;
}

function unavailable(inputsToUse: DiffRangeInputs, preset: 'sinceLastReview' | 'sinceLastComment' | 'sinceEarliestUnresolvedThread'): string {
	const resolution = resolveDiffRangePreset(preset, inputsToUse);
	assert.ok(isUnavailableDiffRange(resolution), `Expected ${preset} to be unavailable`);
	return (resolution as { unavailable: string }).unavailable;
}

describe('diffRange', function () {
	describe('sinceLastReview', function () {
		it('is unavailable without a review', function () {
			assert.strictEqual(unavailable(inputs(), 'sinceLastReview'), 'noReview');
		});

		it('is unavailable when the last review is on the head commit', function () {
			assert.strictEqual(unavailable(inputs({ latestReviewSha: HEAD }), 'sinceLastReview'), 'reviewAtHead');
		});

		it('uses the last review commit as the base', function () {
			const result = resolved(inputs({ latestReviewSha: REVIEWED }), 'sinceLastReview');
			assert.strictEqual(result.baseSha, REVIEWED);
			assert.strictEqual(result.headSha, HEAD);
			assert.strictEqual(result.warning, undefined);
			assert.strictEqual(result.anchor, undefined);
		});
	});

	describe('sinceLastComment', function () {
		it('is unavailable without a signed in viewer', function () {
			const threads = [thread({ comments: [comment({ login: VIEWER, originalCommitId: REVIEWED, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads, viewerLogin: undefined }), 'sinceLastComment'), 'noViewer');
		});

		it('is unavailable without any threads', function () {
			assert.strictEqual(unavailable(inputs(), 'sinceLastComment'), 'noOwnComment');
		});

		it('ignores comments by other users', function () {
			const threads = [thread({ comments: [comment({ login: OTHER, originalCommitId: REVIEWED, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads }), 'sinceLastComment'), 'noOwnComment');
		});

		it('ignores comments without an original commit', function () {
			const threads = [thread({ comments: [comment({ login: VIEWER, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads }), 'sinceLastComment'), 'noOwnComment');
		});

		it('picks the newest of the viewer\'s comments across threads and replies', function () {
			const threads = [
				thread({
					comments: [
						comment({ login: OTHER, originalCommitId: OLDEST, createdAt: '2026-09-01T00:00:00Z', path: 'a.ts' }),
						comment({ login: VIEWER, originalCommitId: REVIEWED, createdAt: '2026-09-03T00:00:00Z', path: 'a.ts' }),
					],
				}),
				thread({
					comments: [
						comment({ login: VIEWER, originalCommitId: OLDER, createdAt: '2026-09-02T00:00:00Z', path: 'b.ts' }),
						comment({ login: OTHER, originalCommitId: HEAD, createdAt: '2026-09-04T00:00:00Z', path: 'b.ts' }),
					],
				}),
			];
			const result = resolved(inputs({ threads }), 'sinceLastComment');
			assert.strictEqual(result.baseSha, REVIEWED);
			assert.deepStrictEqual(result.anchor, { path: 'a.ts', createdAt: '2026-09-03T00:00:00Z' });
		});

		it('is unavailable when the newest comment is on the head commit', function () {
			const threads = [thread({ comments: [comment({ login: VIEWER, originalCommitId: HEAD, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads }), 'sinceLastComment'), 'commentAtHead');
		});
	});

	describe('sinceEarliestUnresolvedThread', function () {
		it('is unavailable without threads', function () {
			assert.strictEqual(unavailable(inputs(), 'sinceEarliestUnresolvedThread'), 'noUnresolvedThread');
		});

		it('is unavailable when every thread is resolved', function () {
			const threads = [thread({ resolved: true, comments: [comment({ login: OTHER, originalCommitId: REVIEWED, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads }), 'sinceEarliestUnresolvedThread'), 'noUnresolvedThread');
		});

		it('picks the earliest unresolved thread by creation date, not by order', function () {
			const threads = [
				thread({ comments: [comment({ login: OTHER, originalCommitId: REVIEWED, createdAt: '2026-09-03T00:00:00Z', path: 'later.ts' })] }),
				thread({ resolved: true, comments: [comment({ login: OTHER, originalCommitId: OLDEST, createdAt: '2026-09-01T00:00:00Z', path: 'resolved.ts' })] }),
				thread({
					comments: [
						comment({ login: VIEWER, originalCommitId: OLDER, createdAt: '2026-09-02T00:00:00Z', path: 'earliest.ts' }),
						comment({ login: OTHER, originalCommitId: HEAD, createdAt: '2026-09-05T00:00:00Z', path: 'earliest.ts' }),
					],
				}),
			];
			const result = resolved(inputs({ threads }), 'sinceEarliestUnresolvedThread');
			assert.strictEqual(result.baseSha, OLDER);
			assert.deepStrictEqual(result.anchor, { path: 'earliest.ts', createdAt: '2026-09-02T00:00:00Z' });
		});

		it('is unavailable when the earliest unresolved thread is on the head commit', function () {
			const threads = [thread({ comments: [comment({ login: OTHER, originalCommitId: HEAD, createdAt: '2026-09-01T00:00:00Z' })] })];
			assert.strictEqual(unavailable(inputs({ threads }), 'sinceEarliestUnresolvedThread'), 'threadAtHead');
		});
	});

	describe('warnings', function () {
		it('warns when the base is not one of the pull request commits', function () {
			const result = resolved(inputs({ latestReviewSha: REVIEWED, commits: [{ sha: OLDER }, { sha: HEAD }] }), 'sinceLastReview');
			assert.strictEqual(result.warning, 'baseNotInPullRequest');
		});

		it('does not warn when the base is one of the pull request commits', function () {
			const result = resolved(inputs({ latestReviewSha: REVIEWED, commits: [{ sha: REVIEWED }, { sha: HEAD }] }), 'sinceLastReview');
			assert.strictEqual(result.warning, undefined);
		});

		it('skips the check when the commit list is empty', function () {
			const result = resolved(inputs({ latestReviewSha: REVIEWED, commits: [] }), 'sinceLastReview');
			assert.strictEqual(result.warning, undefined);
		});
	});

	describe('diffRangeKey', function () {
		it('is stable for equivalent ranges', function () {
			assert.strictEqual(diffRangeKey(ALL_CHANGES), diffRangeKey({ preset: 'all' }));
			assert.strictEqual(diffRangeKey({ preset: 'custom', baseSha: OLDER }), diffRangeKey({ preset: 'custom', baseSha: OLDER, warning: 'baseNotAncestor' }));
		});

		it('differs when the preset, base or head differ', function () {
			assert.notStrictEqual(diffRangeKey(ALL_CHANGES), diffRangeKey({ preset: 'sinceLastReview' }));
			assert.notStrictEqual(diffRangeKey({ preset: 'custom', baseSha: OLDER }), diffRangeKey({ preset: 'custom', baseSha: OLDEST }));
			assert.notStrictEqual(diffRangeKey({ preset: 'custom', baseSha: OLDER }), diffRangeKey({ preset: 'custom', baseSha: OLDER, headSha: REVIEWED }));
		});
	});

	describe('shortSha', function () {
		it('returns the first seven characters', function () {
			assert.strictEqual(shortSha(HEAD), 'd2a9384');
			assert.strictEqual(shortSha('abc'), 'abc');
		});
	});
});
