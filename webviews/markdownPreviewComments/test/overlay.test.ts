/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spy } from 'sinon';
import { onMouseMove, OVERLAY_ID, render } from '../overlay';

const SOURCE = 'pr:/repo/docs/guide.md?%7B%22isBase%22%3Afalse%7D';
const OTHER_SOURCE = 'pr:/repo/docs/guide.md?%7B%22isBase%22%3Atrue%7D';

/**
 * Sets up the document the way the markdown preview does: the preview settings name the shown
 * document, and the markdown-it plugin renders the comment information of every open document.
 */
function setUpPreview(body: string, data: object, source: string = SOURCE): void {
	document.head.innerHTML = `<meta id="vscode-markdown-preview-data" data-settings="${escape(JSON.stringify({ source }))}">`;
	document.body.innerHTML = `<div class="markdown-body">${body}</div>`
		+ `<div id="github-pr-markdown-preview-comments" hidden data-state="${escape(JSON.stringify(data))}"></div>`;
}

function escape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function links(className: string): HTMLAnchorElement[] {
	return Array.from(document.querySelectorAll<HTMLAnchorElement>(`#${OVERLAY_ID} a.${className}`));
}

const BODY = `
<h1 data-line="0" data-pr-end-line="0" class="code-line">Title</h1>
<p data-line="2" data-pr-end-line="3" class="code-line">First line second line</p>
<ul data-line="5" data-pr-end-line="6" class="code-line">
	<li data-line="5" data-pr-end-line="5" class="code-line"><p data-line="5" data-pr-end-line="5" class="code-line">item one</p></li>
	<li data-line="6" data-pr-end-line="6" class="code-line">item two</li>
</ul>`;

describe('markdown preview comments overlay', () => {
	afterEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('adds a comment link to each changed leaf block of the shown document', () => {
		setUpPreview(BODY, {
			[SOURCE]: { commentingRanges: [{ start: 3, end: 5 }], threads: [], commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1' },
			[OTHER_SOURCE]: { commentingRanges: [{ start: 0, end: 6 }], threads: [], commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=2' },
		});

		render();

		assert.deepStrictEqual(links('add').map(link => link.getAttribute('href')), [
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=2&end=3',
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=5&end=5',
		]);
	});

	it('shows the comment count of the threads that end in a block', () => {
		setUpPreview(BODY, {
			[SOURCE]: {
				commentingRanges: [],
				threads: [{ start: 2, end: 3, commentCount: 2, resolved: false }, { start: 6, end: 6, commentCount: 1, resolved: true }],
				commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1',
			},
		});

		render();

		const threads = links('threads');
		assert.deepStrictEqual(threads.map(link => link.textContent), ['2', '1']);
		assert.deepStrictEqual(threads.map(link => link.classList.contains('resolved')), [false, true]);
		assert.strictEqual(threads[0].getAttribute('href'), 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=2&end=3');
	});

	it('adds nothing when there is no comment information for the shown document', () => {
		setUpPreview(BODY, {
			[OTHER_SOURCE]: { commentingRanges: [{ start: 0, end: 6 }], threads: [], commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=2' },
		});

		render();

		assert.strictEqual(document.getElementById(OVERLAY_ID), null);
	});

	it('gives each thread of a block its own badge', () => {
		setUpPreview('<pre data-line="0" data-pr-end-line="20" class="code-line"><code>code</code></pre>', {
			[SOURCE]: {
				commentingRanges: [],
				// Threads in two different diff hunks of the same code block.
				threads: [{ start: 2, end: 3, commentCount: 1, resolved: false }, { start: 15, end: 16, commentCount: 3, resolved: false }],
				commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1',
			},
		});

		render();

		const threads = links('threads');
		assert.deepStrictEqual(threads.map(link => link.textContent), ['1', '3']);
		assert.deepStrictEqual(threads.map(link => link.getAttribute('href')), [
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=2&end=3',
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=15&end=16',
		]);
		assert.notStrictEqual(threads[0].style.left, threads[1].style.left);
	});

	it('keeps comment links reachable with the keyboard', () => {
		setUpPreview(BODY, {
			[SOURCE]: { commentingRanges: [{ start: 2, end: 3 }], threads: [], commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1' },
		});

		render();
		const [link] = links('add');
		link.focus();

		assert.strictEqual(document.activeElement, link);
		assert.ok(link.classList.contains('visible'));
		assert.ok(document.querySelector('p[data-line="2"]')!.classList.contains('github-pr-commentable-hover'));
		link.blur();
		assert.ok(!link.classList.contains('visible'));
	});

	it('adds comment links to the text of list items that contain other lists', () => {
		// A tight nested list renders the parent's text directly in its list item, without a paragraph.
		setUpPreview(`
<ul data-line="0" data-pr-end-line="1" class="code-line">
	<li data-line="0" data-pr-end-line="1" class="code-line">parent
		<ul data-line="1" data-pr-end-line="1" class="code-line">
			<li data-line="1" data-pr-end-line="1" class="code-line">child</li>
		</ul>
	</li>
</ul>`, {
			[SOURCE]: {
				commentingRanges: [{ start: 0, end: 1 }],
				threads: [{ start: 0, end: 0, commentCount: 1, resolved: false }],
				commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1',
			},
		});

		render();

		assert.deepStrictEqual(links('add').map(link => link.getAttribute('href')), [
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=0&end=0',
			'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1&start=1&end=1',
		]);
		assert.deepStrictEqual(links('threads').map(link => link.textContent), ['1']);
	});

	it('finds the hovered block without measuring the layout on every pointer move', () => {
		setUpPreview(BODY, {
			[SOURCE]: { commentingRanges: [{ start: 2, end: 3 }], threads: [], commentUri: 'vscode://github.vscode-pull-request-github/comment-on-markdown-preview?document=1' },
		});
		render();
		const paragraph = document.querySelector('p[data-line="2"]')!;
		paragraph.addEventListener('mousemove', onMouseMove);
		const getBoundingClientRect = spy(Element.prototype, 'getBoundingClientRect');

		try {
			paragraph.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 0 }));
		} finally {
			getBoundingClientRect.restore();
		}

		assert.strictEqual(getBoundingClientRect.callCount, 0);
		assert.ok(paragraph.classList.contains('github-pr-commentable-hover'));
		assert.ok(links('add')[0].classList.contains('visible'));
	});
});

