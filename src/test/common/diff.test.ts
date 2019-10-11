import assert = require('assert');
import { parseDiffHunk, DiffHunk, getModifiedContentFromDiffHunk } from '../../common/diffHunk';
import { DiffLine, DiffChangeType } from '../../common/diffHunk';
import { getDiffLineByPosition, mapHeadLineToDiffHunkPosition, mapCommentsToHead } from '../../common/diffPositionMapping';

const diff_hunk_0 = [
	`@@ -1,5 +1,6 @@`,
	` {`,
	`     "appService.zipIgnorePattern": [`,
	`         "node_modules{,/**}"`,
	`-    ]`,
	`-}`,
	`\\ No newline at end of file`,
	`+    ],`,
	`+    "editor.insertSpaces": false`,
	`+}`
].join('\n');

describe('diff hunk parsing', () => {
	it('diffhunk iterator', () => {
		const diffHunkReader = parseDiffHunk(diff_hunk_0);
		const diffHunkIter = diffHunkReader.next();
		const diffHunk = diffHunkIter.value;
		assert.equal(diffHunk.diffLines.length, 9);

		assert.deepEqual(diffHunk.diffLines[0], new DiffLine(DiffChangeType.Control, -1, -1, 0, `@@ -1,5 +1,6 @@`));
		assert.deepEqual(diffHunk.diffLines[1], new DiffLine(DiffChangeType.Context, 1, 1, 1, ` {`));
		assert.deepEqual(diffHunk.diffLines[2], new DiffLine(DiffChangeType.Context, 2, 2, 2, `     "appService.zipIgnorePattern": [`));
		assert.deepEqual(diffHunk.diffLines[3], new DiffLine(DiffChangeType.Context, 3, 3, 3, `         "node_modules{,/**}"`));
		assert.deepEqual(diffHunk.diffLines[4], new DiffLine(DiffChangeType.Delete, 4, -1, 4, `-    ]`));
		assert.deepEqual(diffHunk.diffLines[5], new DiffLine(DiffChangeType.Delete, 5, -1, 5, `-}`, false));
		assert.deepEqual(diffHunk.diffLines[6], new DiffLine(DiffChangeType.Add, -1, 4, 7, `+    ],`));
		assert.deepEqual(diffHunk.diffLines[7], new DiffLine(DiffChangeType.Add, -1, 5, 8, `+    "editor.insertSpaces": false`));
		assert.deepEqual(diffHunk.diffLines[8], new DiffLine(DiffChangeType.Add, -1, 6, 9, `+}`));
	});

	it('getDiffLineByPosition', () => {
		const diffHunkReader = parseDiffHunk(diff_hunk_0);
		const diffHunkIter = diffHunkReader.next();
		const diffHunk = diffHunkIter.value;

		for (let i = 0; i < diffHunk.diffLines.length; i++) {
			const diffLine = diffHunk.diffLines[i];
			assert.deepEqual(getDiffLineByPosition([diffHunk], diffLine.positionInHunk), diffLine, `diff line ${i}`);
		}
	});

	it('mapHeadLineToDiffHunkPosition', () => {
		const diffHunkReader = parseDiffHunk(diff_hunk_0);
		const diffHunkIter = diffHunkReader.next();
		const diffHunk = diffHunkIter.value;

		for (let i = 0; i < diffHunk.diffLines.length; i++) {
			const diffLine = diffHunk.diffLines[i];
			switch (diffLine.type) {
				case DiffChangeType.Delete:
					assert.equal(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.oldLineNumber, true), diffLine.positionInHunk);
					break;
				case DiffChangeType.Add:
					assert.equal(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.newLineNumber, false), diffLine.positionInHunk);
					break;
				case DiffChangeType.Context:
					assert.equal(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.oldLineNumber, true), diffLine.positionInHunk);
					assert.equal(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.newLineNumber, false), diffLine.positionInHunk);
					break;

				default:
					break;
			}
		}
	});

	it('#239. Diff hunk parsing fails when line count for added content is omitted', () => {
		const diffHunkReader = parseDiffHunk('@@ -0,0 +1 @@');
		const diffHunkIter = diffHunkReader.next();
		const diffHunk = diffHunkIter.value;
		assert.equal(diffHunk.diffLines.length, 1);
	});

	it('', () => {
		const diffHunkReader = parseDiffHunk(`@@ -1 +1,5 @@
# README
+
+This is my readme
+
+Another line"`);
		const diffHunkIter = diffHunkReader.next();
		const diffHunk = diffHunkIter.value;
		assert.equal(diffHunk.diffLines.length, 5);
	});

	describe('mapCommentsToHead', () => {
		it('should ignore comments that are on a deleted diff line', () => {
			const comments = [{
				position: 66
			}];

			const diffHunk = new DiffHunk(481, 16, 489, 10, 54);
			diffHunk.diffLines.push(new DiffLine(DiffChangeType.Delete, 489, -1, 66, '-		this.editorBlurTimeout.cancelAndSet(() => {'));

			const mappedComments = mapCommentsToHead([diffHunk], '', comments as any);
			assert(mappedComments.length === 1);
			assert.equal(mappedComments[0].absolutePosition, undefined);
		});

		it('should handle comments that are on an added diff line', () => {
			const comments = [{
				position: 55
			}];

			const diffHunk = new DiffHunk(481, 16, 481, 17, 54);
			diffHunk.diffLines.push(new DiffLine(DiffChangeType.Add, 481, 482, 55, '+	()	this.editorBlurTimeout.cancelAndSet(() => {'));

			const mappedComments = mapCommentsToHead([diffHunk], '', comments as any);
			assert(mappedComments.length === 1);
			assert.equal(mappedComments[0].absolutePosition, 482);
		});
	});

	describe('getModifiedContentFromDiffHunk', () => {
		const originalContent = [
			`/*---------------------------------------------------------------------------------------------`,
			`*  Copyright (c) Microsoft Corporation. All rights reserved.`,
			`*  Licensed under the MIT License. See License.txt in the project root for license information.`,
			`*--------------------------------------------------------------------------------------------*/`,
			``,
			`'use strict';`,
			``,
			`import { window, commands, ExtensionContext } from 'vscode';`,
			`import { showQuickPick, showInputBox } from './basicInput';`,
			`import { multiStepInput } from './multiStepInput';`,
			`import { quickOpen } from './quickOpen';`,
			``,
			`export function activate(context: ExtensionContext) {`,
			`	context.subscriptions.push(commands.registerCommand('samples.quickInput', async () => {`,
			`		const options: { [key: string]: (context: ExtensionContext) => Promise<void> } = {`,
			`			showQuickPick,`,
			`			showInputBox,`,
			`			multiStepInput,`,
			`			quickOpen,`,
			`		};`,
			`		const quickPick = window.createQuickPick();`,
			`		quickPick.items = Object.keys(options).map(label => ({ label }));`,
			`		quickPick.onDidChangeSelection(selection => {`,
			`			if (selection[0]) {`,
			`				options[selection[0].label](context)`,
			`					.catch(console.error);`,
			`			}`,
			`		});`,
			`		quickPick.onDidHide(() => quickPick.dispose());`,
			`		quickPick.show();`,
			`	}));`,
			`}`
		].join('\n');

		it('returns the original file when there is no patch', () => {
			assert.equal(getModifiedContentFromDiffHunk(originalContent, ''), originalContent);
		});

		it('returns modified content for patch with multiple additions', () => {
			const patch = [
				`"@@ -9,6 +9,7 @@ import { window, commands, ExtensionContext } from 'vscode';`,
				` import { showQuickPick, showInputBox } from './basicInput';`,
				` import { multiStepInput } from './multiStepInput';`,
				` import { quickOpen } from './quickOpen';`,
				`+import { promptCommand } from './promptCommandWithHistory';`,
				` `,
				` export function activate(context: ExtensionContext) {`,
				` 	context.subscriptions.push(commands.registerCommand('samples.quickInput', async () => {`,
				`@@ -17,6 +18,7 @@ export function activate(context: ExtensionContext) {`,
				` 			showInputBox,`,
				` 			multiStepInput,`,
				` 			quickOpen,`,
				`+			promptCommand`,
				` 		};`,
				` 		const quickPick = window.createQuickPick();`,
				` 		quickPick.items = Object.keys(options).map(label => ({ label }));`
			].join('\n');

			const lines = originalContent.split('\n');
			lines.splice(11, 0, `import { promptCommand } from './promptCommandWithHistory';`);
			lines.splice(20, 0, `			promptCommand`);

			const expectedModifiedContent = lines.join('\n');

			const modifiedContent = getModifiedContentFromDiffHunk(originalContent, patch);
			assert.equal(modifiedContent, expectedModifiedContent);
		});
	});
});