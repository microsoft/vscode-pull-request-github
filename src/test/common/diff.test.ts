import { expect } from 'chai';
import { parseDiffHunk } from '../../common/diff';
import { DiffLine, DiffChangeType } from '../../models/diffHunk';
import { getDiffLineByPosition, mapHeadLineToDiffHunkPosition } from '../../common/diffPositionMapping';

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
		let diffHunkReader = parseDiffHunk(diff_hunk_0);
		let diffHunkIter = diffHunkReader.next();
		let diffHunk = diffHunkIter.value;
		expect(diffHunk.diffLines.length).to.equal(9);

		expect(diffHunk.diffLines[0]).to.deep.equal(new DiffLine(DiffChangeType.Control, -1, -1, 0, `@@ -1,5 +1,6 @@`));
		expect(diffHunk.diffLines[1]).to.deep.equal(new DiffLine(DiffChangeType.Context, 1, 1, 1, ` {`));
		expect(diffHunk.diffLines[2]).to.deep.equal(new DiffLine(DiffChangeType.Context, 2, 2, 2, `     "appService.zipIgnorePattern": [`));
		expect(diffHunk.diffLines[3]).to.deep.equal(new DiffLine(DiffChangeType.Context, 3, 3, 3, `         "node_modules{,/**}"`));
		expect(diffHunk.diffLines[4]).to.deep.equal(new DiffLine(DiffChangeType.Delete, 4, -1, 4, `-    ]`));
		expect(diffHunk.diffLines[5]).to.deep.equal(new DiffLine(DiffChangeType.Delete, 5, -1, 5, `-}`, false));
		expect(diffHunk.diffLines[6]).to.deep.equal(new DiffLine(DiffChangeType.Add, -1, 4, 7, `+    ],`));
		expect(diffHunk.diffLines[7]).to.deep.equal(new DiffLine(DiffChangeType.Add, -1, 5, 8, `+    "editor.insertSpaces": false`));
		expect(diffHunk.diffLines[8]).to.deep.equal(new DiffLine(DiffChangeType.Add, -1, 6, 9, `+}`));
	});

	it('getDiffLineByPosition', () => {
		let diffHunkReader = parseDiffHunk(diff_hunk_0);
		let diffHunkIter = diffHunkReader.next();
		let diffHunk = diffHunkIter.value;

		for (let i = 0; i < diffHunk.diffLines.length; i++) {
			let diffLine = diffHunk.diffLines[i];
			expect(getDiffLineByPosition([diffHunk], diffLine.positionInHunk)).to.deep.equal(diffLine, `diff line ${i}`);
		}
	});

	it('mapHeadLineToDiffHunkPosition', () => {
		let diffHunkReader = parseDiffHunk(diff_hunk_0);
		let diffHunkIter = diffHunkReader.next();
		let diffHunk = diffHunkIter.value;

		for (let i = 0; i < diffHunk.diffLines.length; i++) {
			let diffLine = diffHunk.diffLines[i];
			switch (diffLine.type) {
				case DiffChangeType.Delete:
					expect(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.oldLineNumber, true)).to.be.equal(diffLine.positionInHunk);
					break;
				case DiffChangeType.Add:
					expect(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.newLineNumber, false)).to.be.equal(diffLine.positionInHunk);
					break;
				case DiffChangeType.Context:
					expect(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.oldLineNumber, true)).to.be.equal(diffLine.positionInHunk);
					expect(mapHeadLineToDiffHunkPosition([diffHunk], '', diffLine.newLineNumber, false)).to.be.equal(diffLine.positionInHunk);
					break;

				default:
					break;
			}
		}
	});
});