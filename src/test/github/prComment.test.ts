/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { replaceImages } from '../../github/prComment';

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
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://test.ghe.com/github-production-user-asset-6210df/11296/2514616-d81c6ab2-52a6-4ebf-b0c8-125492bd9662.png?TEST"><img src="https://objects-origin.staffship-01.ghe.com/github-production-user-asset-6210df/11296/2514616-d81c6ab2-52a6-4ebf-b0c8-125492bd9662.png?TEST" alt="image" style="max-width: 100%;"></a></p>`;
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
