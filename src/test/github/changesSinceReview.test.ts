/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { Commit } from '../../api/api';
import { GitErrorCodes } from '../../api/api1';
import { GitHubServerType } from '../../common/authentication';
import { GitHubRef } from '../../common/githubRef';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import {
	ChangesSinceReview,
	ChangesSinceReviewContext,
	ChangesSinceReviewUnavailableReason,
	getChangesSinceReview,
	getChangesSinceReviewUnavailableMessage,
} from '../../github/changesSinceReview';
import { CredentialStore } from '../../github/credentials';
import { IRawFileChange } from '../../github/interface';
import { LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { PullRequestModel } from '../../github/pullRequestModel';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { QueryProvider } from '../mocks/queryProvider';

const baseSha = '1111111111111111111111111111111111111111';
const reviewedSha = '2222222222222222222222222222222222222222';
const headSha = '3333333333333333333333333333333333333333';
const reviewedMergeBase = '4444444444444444444444444444444444444444';
const headMergeBase = '5555555555555555555555555555555555555555';
const forkPoint = '6666666666666666666666666666666666666666';

type TreeEntry = { mode: string; object: string };
type Tree = Record<string, TreeEntry>;

const file = (object: string, mode = '100644'): TreeEntry => ({ mode, object });

function fileChange(filename: string, previousFilename?: string, status: IRawFileChange['status'] = previousFilename ? 'renamed' : 'modified'): IRawFileChange {
	return {
		sha: '',
		filename,
		previous_filename: previousFilename,
		additions: 1,
		deletions: 1,
		changes: 2,
		status,
		raw_url: '',
		blob_url: '',
		contents_url: '',
	};
}

const fileNames = (files: readonly IRawFileChange[]) => files.map(change => change.filename);

interface Scenario {
	readonly trees: Record<string, Tree>;
	readonly mergeBases: Record<string, string>;
	/** The changes GitHub reports between the reviewed and head commits. */
	readonly changesSinceReview: IRawFileChange[];
	readonly reviewAndHeadMergeBase: string;
	/** The files GitHub reports the pull request changes at the reviewed and head commits, and that the base branch changed between their merge bases. */
	readonly reviewedFiles: IRawFileChange[];
	readonly headFiles: IRawFileChange[];
	readonly baseBranchFiles: IRawFileChange[];
}

function mergeBases(reviewAndHeadMergeBase: string, reviewed = reviewedMergeBase, head = headMergeBase): Record<string, string> {
	return {
		[`${baseSha}...${reviewedSha}`]: reviewed,
		[`${baseSha}...${headSha}`]: head,
		[`${reviewedSha}...${headSha}`]: reviewAndHeadMergeBase,
	};
}

/**
 * A pull request that was reviewed, then had the base branch merged in along with other changes.
 */
const mergedBaseBranch: Scenario = {
	trees: {
		[reviewedMergeBase]: {
			'src/fromBase.ts': file('base-v1'),
			'src/feature.ts': file('feature-v0'),
			'src/link': file('link-v0'),
			'src/script.sh': file('script-v0'),
			'src/reverted.ts': file('reverted-v0'),
			'src/old.ts': file('old-v0'),
			'lib/handler.js': file('handler-v0'),
		},
		[reviewedSha]: {
			'src/fromBase.ts': file('base-v1'),
			'src/feature.ts': file('feature-v1'),
			'src/link': file('link-v0'),
			'src/script.sh': file('script-v0'),
			'src/reverted.ts': file('reverted-v1'),
			'src/old.ts': file('old-v0'),
			'lib/handler.js': file('handler-v0'),
			':lib/handler.js': file('colon-v1'),
		},
		[headMergeBase]: {
			'src/fromBase.ts': file('base-v2'),
			'src/feature.ts': file('feature-v0'),
			'src/link': file('link-v0'),
			'src/script.sh': file('script-v0'),
			'src/reverted.ts': file('reverted-v0'),
			'src/new.ts': file('old-v0'),
			'lib/handler.js': file('handler-v0'),
		},
		[headSha]: {
			'src/fromBase.ts': file('base-v2'),
			'src/feature.ts': file('feature-v2'),
			'src/added.ts': file('added-v1'),
			'src/link': file('link-target', '120000'),
			'src/script.sh': file('script-v0', '100755'),
			'src/reverted.ts': file('reverted-v0'),
			'src/new.ts': file('old-v0'),
			'lib/handler.js': file('handler-v0'),
			':lib/handler.js': file('colon-v2'),
		},
	},
	mergeBases: mergeBases(reviewedSha),
	changesSinceReview: [
		fileChange('src/fromBase.ts'),
		fileChange('src/feature.ts'),
		fileChange('src/added.ts', undefined, 'added'),
		fileChange('src/link', undefined, 'changed'),
		fileChange('src/script.sh', undefined, 'changed'),
		fileChange('src/reverted.ts'),
		fileChange('src/new.ts', 'src/old.ts'),
		fileChange(':lib/handler.js'),
		fileChange('lib\\handler.js'),
	],
	reviewAndHeadMergeBase: reviewedSha,
	reviewedFiles: [fileChange('src/feature.ts'), fileChange('src/reverted.ts'), fileChange(':lib/handler.js', undefined, 'added')],
	headFiles: [
		fileChange('src/feature.ts'),
		fileChange('src/added.ts', undefined, 'added'),
		fileChange('src/link', undefined, 'changed'),
		fileChange('src/script.sh', undefined, 'changed'),
		fileChange(':lib/handler.js', undefined, 'added'),
	],
	baseBranchFiles: [fileChange('src/fromBase.ts'), fileChange('src/new.ts', 'src/old.ts')],
};

const changesWithoutBaseBranch = ['src/feature.ts', 'src/added.ts', 'src/link', 'src/script.sh', 'src/reverted.ts', ':lib/handler.js', 'lib\\handler.js'];

/**
 * A "Merge branch 'main'" commit that keeps the reviewed versions of files that the base branch fixed in the meantime.
 */
const fakeMerge: Scenario = {
	trees: {
		[reviewedMergeBase]: { 'src/auth.js': file('auth-v1'), 'src/config.js': file('config-v1'), 'src/feature.js': file('feature-v0') },
		[reviewedSha]: { 'src/auth.js': file('auth-v1'), 'src/config.js': file('config-pr'), 'src/feature.js': file('feature-v1') },
		[headMergeBase]: { 'src/auth.js': file('auth-v2-fix'), 'src/config.js': file('config-v2-fix'), 'src/feature.js': file('feature-v0') },
		[headSha]: { 'src/auth.js': file('auth-v1'), 'src/config.js': file('config-pr'), 'src/feature.js': file('feature-v1') },
	},
	mergeBases: mergeBases(reviewedSha),
	changesSinceReview: [],
	reviewAndHeadMergeBase: reviewedSha,
	reviewedFiles: [fileChange('src/config.js'), fileChange('src/feature.js')],
	headFiles: [fileChange('src/auth.js'), fileChange('src/config.js'), fileChange('src/feature.js')],
	baseBranchFiles: [fileChange('src/auth.js'), fileChange('src/config.js')],
};

/**
 * A force push that replaced the reviewed commit, dropping the reviewed admin check.
 */
const forcePush: Scenario = {
	trees: {
		[forkPoint]: { 'src/auth.js': file('auth-v1'), 'src/feature.js': file('feature-v0') },
		[reviewedSha]: { 'src/auth.js': file('auth-require-admin'), 'src/feature.js': file('feature-v0') },
		[headSha]: { 'src/auth.js': file('auth-v1'), 'src/feature.js': file('feature-v2') },
	},
	mergeBases: mergeBases(forkPoint, forkPoint, forkPoint),
	changesSinceReview: [fileChange('src/feature.js')],
	reviewAndHeadMergeBase: forkPoint,
	reviewedFiles: [fileChange('src/auth.js')],
	headFiles: [fileChange('src/feature.js')],
	baseBranchFiles: [],
};

/**
 * A git repository that contains a fixed set of commits and answers tree queries like `git ls-tree -l <treeish> -- <pathspec>`.
 */
class LocalTreesRepository extends MockRepository {
	readonly getObjectDetailsCalls: string[][] = [];

	constructor(
		private readonly scenario: Scenario,
		private readonly commits: Record<string, string> = { [baseSha]: baseSha, [reviewedSha]: reviewedSha, [headSha]: headSha },
		private readonly failingPath?: string,
	) {
		super();
	}

	override async getCommit(ref: string): Promise<Commit> {
		const hash = this.commits[ref];
		if (!hash) {
			throw new Error(`fatal: bad object ${ref}`);
		}
		return { hash, message: '', parents: [] };
	}

	override async getMergeBase(ref1: string, ref2: string): Promise<string> {
		const mergeBase = this.scenario.mergeBases[`${ref1}...${ref2}`];
		if (!mergeBase) {
			throw new Error(`Unexpected getMergeBase(${ref1}, ${ref2})`);
		}
		return mergeBase;
	}

	override async getObjectDetails(treeish: string, pathspec: string): Promise<{ mode: string; object: string; size: number }> {
		this.getObjectDetailsCalls.push([treeish, pathspec]);
		const literalPrefix = ':(literal)';
		if (!pathspec.startsWith(literalPrefix)) {
			throw new Error(`Expected a literal pathspec but got ${pathspec}`);
		}
		const path = pathspec.substring(literalPrefix.length);
		if (path === this.failingPath) {
			throw new Error('fatal: unable to read tree');
		}
		const entry = this.scenario.trees[treeish]?.[path];
		if (!entry) {
			throw Object.assign(new Error('Path not known by git'), { gitErrorCode: GitErrorCodes.UnknownPath });
		}
		return { ...entry, size: 0 };
	}
}

const notLocal = (scenario: Scenario) => new LocalTreesRepository(scenario, {});

class GitHubComparisons {
	constructor(private readonly queryProvider: QueryProvider, private readonly remote: GitHubRemote, private readonly baseOwner: string, private readonly headOwner: string) { }

	expect(base: string, head: string, files: IRawFileChange[], mergeBase: string, headOwner = this.baseOwner) {
		this.queryProvider.expectOctokitRequest(['repos', 'compareCommits'], [{
			repo: this.remote.repositoryName,
			owner: this.remote.owner,
			base: `${this.baseOwner}:${base}`,
			head: `${headOwner}:${head}`,
		}], {
			files,
			merge_base_commit: { sha: mergeBase },
		});
	}

	expectSinceReview(scenario: Scenario) {
		this.expect(reviewedSha, headSha, scenario.changesSinceReview, scenario.reviewAndHeadMergeBase, this.headOwner);
	}

	expectHeadFiles(scenario: Scenario) {
		this.expect(baseSha, headSha, scenario.headFiles, scenario.mergeBases[`${baseSha}...${headSha}`], this.headOwner);
	}

	expectAll(scenario: Scenario, baseBranchFiles = scenario.baseBranchFiles) {
		const reviewed = scenario.mergeBases[`${baseSha}...${reviewedSha}`];
		const head = scenario.mergeBases[`${baseSha}...${headSha}`];
		this.expectSinceReview(scenario);
		this.expectHeadFiles(scenario);
		this.expect(baseSha, reviewedSha, scenario.reviewedFiles, reviewed);
		this.expect(reviewed, head, baseBranchFiles, reviewed);
	}
}

describe('changesSinceReview', function () {
	const telemetry = new MockTelemetry();
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('getChangesSinceReview', function () {
		const remote = new GitHubRemote('origin', 'github/test', new Protocol('https://github.com/github/test.git'), GitHubServerType.GitHubDotCom);
		const base = new GitHubRef('main', 'github:main', baseSha, 'https://github.com/github/test.git', 'github', 'test', false);
		const head = new GitHubRef('feature', 'github:feature', headSha, 'https://github.com/github/test.git', 'github', 'test', false);
		let gitHub: GitHubComparisons;
		let context: ChangesSinceReviewContext;

		beforeEach(function () {
			const queryProvider = new QueryProvider(sinon);
			gitHub = new GitHubComparisons(queryProvider, remote, 'github', 'github');
			context = {
				remote,
				octokit: new LoggingOctokit(queryProvider.octokit, new RateLogger(telemetry, true)),
				base,
				head,
				reviewedSha,
				prNumber: 1,
			};
		});

		function check(scenario: Scenario, repository?: LocalTreesRepository): Promise<ChangesSinceReview> {
			return getChangesSinceReview(scenario.changesSinceReview, scenario.reviewAndHeadMergeBase, { ...context, repository });
		}

		function assertUnavailable(result: ChangesSinceReview, reason: ChangesSinceReviewUnavailableReason, expectedFileNames: string[] = []) {
			assert.strictEqual(result.kind, 'unavailable');
			if (result.kind === 'unavailable') {
				assert.strictEqual(result.reason, reason);
				assert.deepStrictEqual(result.fileNames, expectedFileNames);
			}
		}

		function assertAvailable(result: ChangesSinceReview, expectedFileNames: string[]) {
			assert.strictEqual(result.kind, 'available', JSON.stringify(result));
			if (result.kind === 'available') {
				assert.deepStrictEqual(fileNames(result.files), expectedFileNames);
			}
		}

		describe('with local git', function () {
			it('keeps every change when nothing was merged from the base branch since the review', async function () {
				const scenario: Scenario = { ...mergedBaseBranch, mergeBases: mergeBases(reviewedSha, reviewedMergeBase, reviewedMergeBase) };
				const repository = new LocalTreesRepository(scenario);

				const result = await check(scenario, repository);

				assertAvailable(result, fileNames(scenario.changesSinceReview));
				assert.deepStrictEqual(repository.getObjectDetailsCalls, []);
			});

			it('removes files that only changed in the base branch', async function () {
				gitHub.expectHeadFiles(mergedBaseBranch);
				const repository = new LocalTreesRepository(mergedBaseBranch);

				const result = await check(mergedBaseBranch, repository);

				assertAvailable(result, changesWithoutBaseBranch);
				assert.ok(repository.getObjectDetailsCalls.every(([, pathspec]) => pathspec.startsWith(':(literal)') && !pathspec.includes('\\')));
				assert.ok(repository.getObjectDetailsCalls.some(([, pathspec]) => pathspec === ':(literal):lib/handler.js'));
			});

			it('keeps files whose tree entries cannot be read', async function () {
				gitHub.expectHeadFiles(mergedBaseBranch);

				const result = await check(mergedBaseBranch, new LocalTreesRepository(mergedBaseBranch, undefined, 'src/fromBase.ts'));

				assertAvailable(result, ['src/fromBase.ts', ...changesWithoutBaseBranch]);
			});

			it('is unavailable when a merge kept reviewed versions of files the base branch changed', async function () {
				gitHub.expectHeadFiles(fakeMerge);

				const result = await check(fakeMerge, new LocalTreesRepository(fakeMerge));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, ['src/auth.js', 'src/config.js']);
			});

			it('is unavailable when a file the pull request changes cannot be checked locally', async function () {
				gitHub.expectHeadFiles({ ...mergedBaseBranch, headFiles: [...mergedBaseBranch.headFiles, fileChange('lib\\handler.js', undefined, 'added')] });

				const result = await check(mergedBaseBranch, new LocalTreesRepository(mergedBaseBranch));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, ['lib\\handler.js']);
			});

			it('is unavailable and lists dropped files when the reviewed commit is no longer in the pull request', async function () {
				gitHub.expect(baseSha, reviewedSha, forcePush.reviewedFiles, forkPoint);

				const result = await check(forcePush, new LocalTreesRepository(forcePush));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest, ['src/auth.js']);
			});

			it('is still unavailable when the files dropped from the pull request cannot be listed', async function () {
				const result = await check(forcePush, new LocalTreesRepository(forcePush));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest);
			});

			it('cannot verify when the list of files the pull request changes may be truncated', async function () {
				gitHub.expectHeadFiles({ ...fakeMerge, headFiles: Array.from({ length: 300 }, (_, i) => fileChange(`src/generated${i}.ts`)) });

				const result = await check(fakeMerge, new LocalTreesRepository(fakeMerge));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.CannotVerify);
			});

			it('cannot verify when the comparison does not start at the reviewed commit even though the reviewed commit is an ancestor of the head', async function () {
				const result = await check({ ...mergedBaseBranch, reviewAndHeadMergeBase: baseSha }, new LocalTreesRepository(mergedBaseBranch));

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.CannotVerify);
			});

			it('uses GitHub when a local commit does not match the pull request commit', async function () {
				gitHub.expectAll(fakeMerge);
				const repository = new LocalTreesRepository(fakeMerge, { [baseSha]: baseSha, [reviewedSha]: reviewedMergeBase, [headSha]: headSha });

				const result = await check(fakeMerge, repository);

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, ['src/auth.js', 'src/config.js']);
				assert.deepStrictEqual(repository.getObjectDetailsCalls, []);
			});
		});

		describe('with GitHub', function () {
			it('removes files that only changed in the base branch', async function () {
				gitHub.expectAll(mergedBaseBranch);

				const result = await check(mergedBaseBranch, notLocal(mergedBaseBranch));

				// GitHub's lists show that the pull request never changes `lib\handler.js`, so it can be removed without a local lookup.
				assertAvailable(result, changesWithoutBaseBranch.filter(fileName => fileName !== 'lib\\handler.js'));
			});

			it('is unavailable when a merge kept reviewed versions of files the base branch changed', async function () {
				gitHub.expectAll(fakeMerge);

				const result = await check(fakeMerge);

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, ['src/auth.js', 'src/config.js']);
			});

			it('cannot verify when the base branch comparison may be truncated', async function () {
				gitHub.expectAll(fakeMerge, Array.from({ length: 300 }, (_, i) => fileChange(`src/generated${i}.ts`)));

				const result = await check(fakeMerge);

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.CannotVerify);
			});

			it('is unavailable and lists dropped files when the reviewed commit is no longer in the pull request', async function () {
				gitHub.expectSinceReview(forcePush);
				gitHub.expectHeadFiles(forcePush);
				gitHub.expect(baseSha, reviewedSha, forcePush.reviewedFiles, forkPoint);

				const result = await check(forcePush);

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest, ['src/auth.js']);
			});

			it('does not list dropped files when the reviewed file list may be truncated', async function () {
				gitHub.expectSinceReview(forcePush);
				gitHub.expectHeadFiles(forcePush);
				gitHub.expect(baseSha, reviewedSha, Array.from({ length: 300 }, (_, i) => fileChange(`src/generated${i}.ts`)), forkPoint);

				const result = await check(forcePush);

				assertUnavailable(result, ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest);
			});
		});
	});

	describe('getChangesSinceReviewUnavailableMessage', function () {
		const message = (reason: ChangesSinceReviewUnavailableReason, fileNames: string[] = []) =>
			getChangesSinceReviewUnavailableMessage({ kind: 'unavailable', reason, fileNames }, 12);

		it('names at most five files', function () {
			const text = message(ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

			assert.ok(text.includes('#12'), text);
			assert.ok(text.endsWith('Affected files: a, b, c, d, e and 2 more'), text);
		});

		it('names the dropped files only when they are known', function () {
			const withFiles = message(ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest, ['src/auth.js']);
			const withoutFiles = message(ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest);

			assert.ok(withFiles.endsWith('no longer changes: src/auth.js'), withFiles);
			assert.ok(withoutFiles.endsWith('so all changes are shown.'), withoutFiles);
			assert.ok(withoutFiles.includes('#12'), withoutFiles);
		});

		it('explains when the changes could not be verified', function () {
			const text = message(ChangesSinceReviewUnavailableReason.CannotVerify);

			assert.ok(text.includes('could not be verified') && text.includes('#12'), text);
		});
	});

	describe('PullRequestModel.getRawFileChangesInfo', function () {
		const remote = new GitHubRemote('test', 'github/test', new Protocol('https://github.com/github/test.git'), GitHubServerType.GitHubDotCom);
		let context: MockExtensionContext;
		let credentials: CredentialStore;
		let repo: MockGitHubRepository;

		beforeEach(function () {
			MockCommandRegistry.install(sinon);
			context = new MockExtensionContext();
			credentials = new CredentialStore(telemetry, context);
			repo = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		});

		afterEach(function () {
			repo.dispose();
			context.dispose();
			credentials.dispose();
		});

		function createModel(showChangesSinceReview: boolean): { model: PullRequestModel; gitHub: GitHubComparisons } {
			const pr = new PullRequestBuilder()
				.base(b => b.sha(baseSha))
				.head(h => h.sha(headSha))
				.build();
			const model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			sinon.stub(model, 'getViewerLatestReviewCommit').resolves({ sha: reviewedSha });
			model.showChangesSinceReview = showChangesSinceReview;
			const gitHub = new GitHubComparisons(repo.queryProvider, remote, model.base.repositoryCloneUrl.owner, model.head!.repositoryCloneUrl.owner);
			return { model, gitHub };
		}

		it('shows the changes since the review without base branch changes', async function () {
			const { model, gitHub } = createModel(true);
			gitHub.expectSinceReview(mergedBaseBranch);
			gitHub.expectHeadFiles(mergedBaseBranch);
			const showWarningMessage = sinon.stub(vscode.window, 'showWarningMessage').resolves();

			const files = await model.getRawFileChangesInfo(new LocalTreesRepository(mergedBaseBranch));

			assert.deepStrictEqual(fileNames(files), changesWithoutBaseBranch);
			assert.strictEqual(model.mergeBase, reviewedSha);
			assert.ok(showWarningMessage.notCalled);
		});

		it('shows all changes and warns once when a merge changed what the pull request does', async function () {
			const { model, gitHub } = createModel(true);
			gitHub.expectSinceReview(fakeMerge);
			gitHub.expectHeadFiles(fakeMerge);
			const showWarningMessage = sinon.stub(vscode.window, 'showWarningMessage').resolves();

			const files = await model.getRawFileChangesInfo(new LocalTreesRepository(fakeMerge));
			await model.getRawFileChangesInfo(new LocalTreesRepository(fakeMerge));

			assert.deepStrictEqual(fileNames(files), fileNames(fakeMerge.headFiles));
			assert.strictEqual(model.mergeBase, headMergeBase);
			assert.ok(showWarningMessage.calledOnce);
			const [message] = showWarningMessage.firstCall.args;
			assert.ok(message.includes('src/auth.js, src/config.js'), message);
		});

		it('shows all changes when the reviewed commit is no longer in the pull request', async function () {
			const { model, gitHub } = createModel(true);
			gitHub.expectSinceReview(forcePush);
			gitHub.expectHeadFiles(forcePush);
			gitHub.expect(baseSha, reviewedSha, forcePush.reviewedFiles, forkPoint);
			const showWarningMessage = sinon.stub(vscode.window, 'showWarningMessage').resolves();

			const files = await model.getRawFileChangesInfo();

			assert.deepStrictEqual(fileNames(files), fileNames(forcePush.headFiles));
			assert.strictEqual(model.mergeBase, forkPoint);
			assert.ok(showWarningMessage.calledOnce);
			assert.ok(showWarningMessage.firstCall.args[0].includes('src/auth.js'));
		});

		it('does not check the history when showing all changes', async function () {
			const { model, gitHub } = createModel(false);
			const changes = [fileChange('src/fromBase.ts'), fileChange('src/feature.ts')];
			gitHub.expect(baseSha, headSha, changes, baseSha, model.head!.repositoryCloneUrl.owner);
			const repository = new LocalTreesRepository(mergedBaseBranch);

			const files = await model.getRawFileChangesInfo(repository);

			assert.deepStrictEqual(files, changes);
			assert.deepStrictEqual(repository.getObjectDetailsCalls, []);
		});
	});
});
