import { expect } from 'chai';
import { parseDiffHunk } from '../../common/diff';
import { DiffLine, DiffChangeType } from '../../models/diffHunk';

describe('parseDiffHunk', () => {
	it('diffhunk iterator', () => {
		let diffHunkReader = parseDiffHunk([
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
		].join('\n'));
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
});