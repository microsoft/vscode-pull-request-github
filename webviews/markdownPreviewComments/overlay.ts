/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Draws the commenting affordances of the markdown preview, see index.ts.
 */

const PREVIEW_DATA_ELEMENT_ID = 'github-pr-markdown-preview-comments';
const END_LINE_ATTRIBUTE = 'data-pr-end-line';
const BLOCK_SELECTOR = `[data-line][${END_LINE_ATTRIBUTE}]`;
export const OVERLAY_ID = 'github-pr-markdown-preview-comments-overlay';

interface LineRange {
	start: number;
	end: number;
}

interface PreviewCommentState {
	commentingRanges: LineRange[];
	threads: (LineRange & { commentCount: number; resolved: boolean })[];
	commentUri: string;
}

interface Block extends LineRange {
	element: Element;
}

export function installStyles(): void {
	const style = document.createElement('style');
	style.textContent = `
#${OVERLAY_ID} {
	position: absolute;
	top: 0;
	left: 0;
	width: 0;
	height: 0;
}
#${OVERLAY_ID} a {
	position: absolute;
	display: flex;
	align-items: center;
	justify-content: center;
	min-width: 18px;
	height: 18px;
	padding: 0 3px;
	box-sizing: border-box;
	border-radius: 4px;
	font-size: 12px;
	line-height: 1;
	text-decoration: none;
	cursor: pointer;
	user-select: none;
}
#${OVERLAY_ID} a.add {
	visibility: hidden;
	color: var(--vscode-button-foreground);
	background-color: var(--vscode-button-background);
}
#${OVERLAY_ID} a.add.visible {
	visibility: visible;
}
#${OVERLAY_ID} a.threads {
	color: var(--vscode-badge-foreground);
	background-color: var(--vscode-badge-background);
}
#${OVERLAY_ID} a.threads.resolved {
	opacity: 0.6;
}
.github-pr-commentable-hover {
	outline: 1px dashed var(--vscode-editorGutter-commentRangeForeground, var(--vscode-focusBorder));
	outline-offset: 2px;
}
`;
	document.head.appendChild(style);
}

function readState(): PreviewCommentState | undefined {
	const data = document.getElementById(PREVIEW_DATA_ELEMENT_ID)?.getAttribute('data-state');
	const settings = document.getElementById('vscode-markdown-preview-data')?.getAttribute('data-settings');
	if (!data || !settings) {
		return undefined;
	}
	try {
		// The data is keyed by document, and the preview's settings say which document is shown.
		const states: { [uri: string]: PreviewCommentState } = JSON.parse(data);
		const source: string | undefined = JSON.parse(settings).source;
		return source ? states[source] : undefined;
	} catch {
		return undefined;
	}
}

function intersects(a: LineRange, b: LineRange): boolean {
	return a.start <= b.end && a.end >= b.start;
}

/**
 * Gets the innermost rendered blocks, such as paragraphs, headings, table rows and code blocks,
 * so that a list or a table doesn't get a single button for all of its content.
 */
function getLeafBlocks(): Block[] {
	const blocks: Block[] = [];
	for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
		if (element.querySelector(BLOCK_SELECTOR)) {
			continue;
		}
		const start = Number(element.getAttribute('data-line'));
		const end = Number(element.getAttribute(END_LINE_ATTRIBUTE));
		if (Number.isInteger(start) && Number.isInteger(end)) {
			blocks.push({ element, start, end });
		}
	}
	return blocks;
}

function commentLink(state: PreviewCommentState, range: LineRange): string {
	return `${state.commentUri}&start=${range.start}&end=${range.end}`;
}

function createLink(className: string, href: string, text: string, title: string, top: number, left: number): HTMLAnchorElement {
	const link = document.createElement('a');
	link.className = className;
	link.href = href;
	link.textContent = text;
	link.title = title;
	link.setAttribute('aria-label', title);
	link.style.top = `${top}px`;
	link.style.left = `${left}px`;
	return link;
}

let hoverTarget: Element | undefined;
let addLinks = new Map<Element, HTMLAnchorElement>();

export function render(): void {
	setHoverTarget(undefined);
	document.getElementById(OVERLAY_ID)?.remove();
	addLinks = new Map();

	const state = readState();
	if (!state) {
		return;
	}

	const overlay = document.createElement('div');
	overlay.id = OVERLAY_ID;
	document.body.appendChild(overlay);
	// Position everything relative to the overlay, in the margins on either side of the content.
	const origin = overlay.getBoundingClientRect();
	const addLeft = 4 - origin.left;
	const threadsLeft = document.documentElement.clientWidth - 24 - origin.left;

	for (const block of getLeafBlocks()) {
		const top = block.element.getBoundingClientRect().top - origin.top;

		if (state.commentingRanges.some(range => intersects(range, block))) {
			const link = createLink('add', commentLink(state, block), '+', 'Add a pull request comment', top, addLeft);
			overlay.appendChild(link);
			addLinks.set(block.element, link);
		}

		// GitHub anchors a comment thread on its last line.
		const threads = state.threads.filter(thread => thread.end >= block.start && thread.end <= block.end);
		if (threads.length) {
			const commentCount = threads.reduce((count, thread) => count + thread.commentCount, 0);
			const range = { start: Math.min(...threads.map(thread => thread.start)), end: Math.max(...threads.map(thread => thread.end)) };
			const resolved = threads.every(thread => thread.resolved);
			const title = commentCount === 1 ? 'Show 1 comment' : `Show ${commentCount} comments`;
			overlay.appendChild(createLink(`threads${resolved ? ' resolved' : ''}`, commentLink(state, range), String(commentCount), title, top, threadsLeft));
		}
	}
}

export function setHoverTarget(element: Element | undefined): void {
	if (element === hoverTarget) {
		return;
	}
	if (hoverTarget) {
		hoverTarget.classList.remove('github-pr-commentable-hover');
		addLinks.get(hoverTarget)?.classList.remove('visible');
	}
	hoverTarget = element;
	if (hoverTarget) {
		hoverTarget.classList.add('github-pr-commentable-hover');
		addLinks.get(hoverTarget)?.classList.add('visible');
	}
}

export function onMouseMove(event: MouseEvent): void {
	const target = event.target as Element | null;
	if (!target) {
		return;
	}
	if (target.closest(`#${OVERLAY_ID}`)) {
		return;
	}
	// Find the block on the same line as the pointer, which also works when hovering in the margin.
	const element = [...addLinks.keys()].find(block => {
		const rect = block.getBoundingClientRect();
		return event.clientY >= rect.top && event.clientY <= rect.bottom;
	});
	setHoverTarget(element);
}
