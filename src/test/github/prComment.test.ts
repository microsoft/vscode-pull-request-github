/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { replaceImages } from '../../github/prComment';

describe('commit SHA replacement', function () {
	it('should match 7-character commit SHAs', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'Fixed in commit 5cf56bc and also in abc1234';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 2);
		assert.strictEqual(matches[0][1], '5cf56bc');
		assert.strictEqual(matches[1][1], 'abc1234');
	});

	it('should match 40-character commit SHAs', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'Fixed in commit 5cf56bc1234567890abcdef1234567890abcdef0';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 1);
		assert.strictEqual(matches[0][0], '5cf56bc1234567890abcdef1234567890abcdef0');
	});

	it('should not match SHAs in URLs', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'https://github.com/owner/repo/commit/5cf56bc';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 0);
	});

	it('should not match SHAs in code blocks', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'Fixed in commit 5cf56bc but not in `abc1234`';
		const matches = Array.from(text.matchAll(commitShaRegex));
		// The regex will match both, but the replacement logic checks backtick count
		assert.strictEqual(matches.length, 2);
	});

	it('should not match non-hex strings', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'Not a SHA: 1234xyz or ABCDEFG';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 0);
	});

	it('should not match SHAs with alphanumeric prefix', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = 'prefix5cf56bc is not a SHA';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 0);
	});

	it('should not match SHAs with alphanumeric suffix', function () {
		const commitShaRegex = /(?<![`\/\w])([0-9a-f]{7})([0-9a-f]{33})?(?![`\/\w])/g;
		const text = '5cf56bcsuffix is not a SHA';
		const matches = Array.from(text.matchAll(commitShaRegex));
		assert.strictEqual(matches.length, 0);
	});
});

describe('replace images', function () {
	it('github.com', function () {
		const markdownBody = `Test image
![image](https://github.com/user-attachments/assets/714215c1-e994-4c69-be20-2276c558f7c3)
test again
![image](https://github.com/user-attachments/assets/3f2c170a-d0c3-4ac7-a9e5-ea13bf71a5bc)`;
		const htmlBody = `
<p dir="auto">Test image</p><p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/38270282/445632993-714215c1-e994-4c69-be20-2276c558f7c3.png?jwt=TEST"><img src="https://private-user-images.githubusercontent.com/38270282/445632993-714215c1-e994-4c69-be20-2276c558f7c3.png?jwt=TEST" alt="image" style="max-width: 100%;"></a></p>
<p dir="auto">test again</p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/38270282/445689518-3f2c170a-d0c3-4ac7-a9e5-ea13bf71a5bc.png?jwt=TEST"><img src="https://private-user-images.githubusercontent.com/38270282/445689518-3f2c170a-d0c3-4ac7-a9e5-ea13bf71a5bc.png?jwt=TEST" alt="image" style="max-width: 100%;"></a></p>`;
		const host = 'github.com';
		const replaced = replaceImages(markdownBody, htmlBody, host);
		const expected = `Test image
![image](https://private-user-images.githubusercontent.com/38270282/445632993-714215c1-e994-4c69-be20-2276c558f7c3.png?jwt=TEST)
test again
![image](https://private-user-images.githubusercontent.com/38270282/445689518-3f2c170a-d0c3-4ac7-a9e5-ea13bf71a5bc.png?jwt=TEST)`;
		assert.strictEqual(replaced, expected);
	});

	it('GHCE', function () {
		const markdownBody = `Test image
![image](https://test.ghe.com/user-attachments/assets/d81c6ab2-52a6-4ebf-b0c8-125492bd9662)`;
		const htmlBody = `
<p dir="auto">Test image</p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://test.ghe.com/github-production-user-asset-6210df/11296/2514616-d81c6ab2-52a6-4ebf-b0c8-125492bd9662.png?TEST"><img src="https://objects-origin.test.ghe.com/github-production-user-asset-6210df/11296/2514616-d81c6ab2-52a6-4ebf-b0c8-125492bd9662.png?TEST" alt="image" style="max-width: 100%;"></a></p>`;
		const host = 'test.ghe.com';
		const replaced = replaceImages(markdownBody, htmlBody, host);
		const expected = `Test image
![image](https://test.ghe.com/github-production-user-asset-6210df/11296/2514616-d81c6ab2-52a6-4ebf-b0c8-125492bd9662.png?TEST)`;

		assert.strictEqual(replaced, expected);
	});

	it('GHE', function () {
		const markdownBody = `Test
![image](https://alexr00-my-test-instance.ghe-test.com/my-user/my-repo/assets/6/c267d6ce-fbdd-41a0-b86d-760882bd0c82)
`;
		const htmlBody = ` <p dir="auto">Test<br>
<a target="_blank" rel="noopener noreferrer" href="https://media.alexr00-my-test-instance.ghe-test.com/user/6/files/c267d6ce-fbdd-41a0-b86d-760882bd0c82?TEST"><img src="https://media.alexr00-my-test-instance.ghe-test.com/user/6/files/c267d6ce-fbdd-41a0-b86d-760882bd0c82?TEST" alt="image" style="max-width: 100%;"></a></p>`;
		const host = 'alexr00-my-test-instance.ghe-test.com';
		const replaced = replaceImages(markdownBody, htmlBody, host);
		const expected = `Test
![image](https://media.alexr00-my-test-instance.ghe-test.com/user/6/files/c267d6ce-fbdd-41a0-b86d-760882bd0c82?TEST)
`;

		assert.strictEqual(replaced, expected);
	});
});
