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
const THREAD_BADGE_SPACING = 22;
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
	opacity: 0;
	color: var(--vscode-button-foreground);
	background-color: var(--vscode-button-background);
}
#${OVERLAY_ID} a.add.visible,
#${OVERLAY_ID} a.add:focus-visible {
	opacity: 1;
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
 * Gets the blocks that can be commented on: the innermost rendered blocks, such as paragraphs, headings,
 * table rows and code blocks, so that a list or a table doesn't get a single button for all of its content.
 * A block that contains other blocks only gets its own lines before them, such as the text of a list item
 * in a tight list, which isn't rendered in a paragraph.
 */
function getBlocks(): Block[] {
	const blocks: Block[] = [];
	for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
		const start = Number(element.getAttribute('data-line'));
		let end = Number(element.getAttribute(END_LINE_ATTRIBUTE));
		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			continue;
		}
		const firstInnerBlock = element.querySelector(BLOCK_SELECTOR);
		if (firstInnerBlock) {
			const innerStart = Number(firstInnerBlock.getAttribute('data-line'));
			if (!(innerStart > start)) {
				continue;
			}
			end = Math.min(end, innerStart - 1);
		}
		blocks.push({ element, start, end });
	}
	return blocks;
}

function commentLink(state: PreviewCommentState, range: LineRange, revealThread: boolean = false): string {
	return `${state.commentUri}&start=${range.start}&end=${range.end}${revealThread ? '&thread=1' : ''}`;
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
/**
 * The vertical bounds of the blocks with comment links, in document coordinates. They're measured when rendering,
 * which happens again when the layout changes, so that moving the pointer doesn't force a layout.
 */
let hoverAreas: { element: Element; top: number; bottom: number }[] = [];

export function render(): void {
	setHoverTarget(undefined);
	document.getElementById(OVERLAY_ID)?.remove();
	addLinks = new Map();
	hoverAreas = [];

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

	for (const block of getBlocks()) {
		const rect = block.element.getBoundingClientRect();
		const top = rect.top - origin.top;

		if (state.commentingRanges.some(range => intersects(range, block))) {
			// The links stay in the tab order, and show the block they comment on when focused with the keyboard.
			const link = createLink('add', commentLink(state, block), '+', 'Add a pull request comment', top, addLeft);
			link.addEventListener('focus', () => setHoverTarget(block.element));
			link.addEventListener('blur', () => setHoverTarget(undefined));
			overlay.appendChild(link);
			addLinks.set(block.element, link);
			hoverAreas.push({ element: block.element, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY });
		}

		// GitHub anchors a comment thread on its last line. Each thread gets its own badge, since the threads
		// of a block can be in different diff hunks.
		const threads = state.threads.filter(thread => thread.end >= block.start && thread.end <= block.end);
		threads.forEach((thread, index) => {
			const title = thread.commentCount === 1 ? 'Show 1 comment' : `Show ${thread.commentCount} comments`;
			const left = threadsLeft - index * THREAD_BADGE_SPACING;
			overlay.appendChild(createLink(`threads${thread.resolved ? ' resolved' : ''}`, commentLink(state, thread, true), String(thread.commentCount), title, top, left));
		});
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
	// Blocks can contain other blocks, such as nested list items, so prefer the innermost one.
	const y = event.clientY + window.scrollY;
	let match: { element: Element; top: number; bottom: number } | undefined;
	for (const area of hoverAreas) {
		if (y >= area.top && y <= area.bottom && (!match || area.bottom - area.top < match.bottom - match.top)) {
			match = area;
		}
	}
	setHoverTarget(match?.element);
}
