/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { renderAzureMarkdown } from '../../azure/markdown';
import { unifiedPatch } from '../../azure/patch';
import { DiffChangeType, parsePatch } from '../../common/diffHunk';

function reconstruct(base: string, patch: string): string {
	const source = base.split('\n');
	if (source[source.length - 1] === '') {
		source.pop();
	}
	const result: string[] = [];
	let index = 0;
	for (const hunk of parsePatch(patch)) {
		const start = hunk.oldLength ? hunk.oldLineNumber - 1 : hunk.oldLineNumber;
		while (index < start) {
			result.push(source[index++]);
		}
		for (const line of hunk.diffLines) {
			if (line.type === DiffChangeType.Context) {
				assert.strictEqual(source[index++], line.text);
				result.push(line.text);
			} else if (line.type === DiffChangeType.Delete) {
				assert.strictEqual(source[index++], line.text);
			} else if (line.type === DiffChangeType.Add) {
				result.push(line.text);
			}
		}
	}
	while (index < source.length) {
		result.push(source[index++]);
	}
	return result.join('\n');
}

describe('Azure content rendering for the original views', () => {
	it('produces patches that the original diff parser reconstructs exactly', () => {
		let seed = 11;
		const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (let test = 0; test < 500; test++) {
			const base = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 5)));
			const head = base.filter(() => random() > 0.2).flatMap(line => random() > 0.85 ? [line, `new ${Math.floor(random() * 5)}`] : [line]);
			const text = (lines: string[]) => lines.length ? `${lines.join('\n')}\n` : '';
			const { patch, additions, deletions } = unifiedPatch(text(base), text(head));
			assert.strictEqual(reconstruct(text(base), patch), head.join('\n'));
			assert.ok(additions >= 0 && deletions >= 0);
		}
	});

	it('handles added, deleted, unchanged and very large rewritten files', () => {
		assert.deepStrictEqual(unifiedPatch('', 'a\nb\n'), { patch: '@@ -0,0 +1,2 @@\n+a\n+b', additions: 2, deletions: 0 });
		assert.deepStrictEqual(unifiedPatch('a\n', ''), { patch: '@@ -1,1 +0,0 @@\n-a', additions: 0, deletions: 1 });
		assert.deepStrictEqual(unifiedPatch('same\n', 'same\n'), { patch: '', additions: 0, deletions: 0 });
		const large = Array.from({ length: 20000 }, (_, index) => `line ${index}`);
		const result = unifiedPatch(large.join('\n'), large.map(line => `${line}!`).join('\n'));
		assert.strictEqual(result.additions, 20000);
		assert.strictEqual(result.deletions, 20000);
	});

	it('renders Markdown while showing raw HTML and unsafe links as text', () => {
		const html = renderAzureMarkdown('**ok** <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://example.com) ![i](http://insecure/x.png)');
		assert.ok(html.includes('<strong>ok</strong>'));
		assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
		assert.ok(!html.includes('javascript:'));
		assert.ok(html.includes('<a href="https://example.com/">good</a>'));
		assert.ok(!html.includes('<img'));
	});
});
