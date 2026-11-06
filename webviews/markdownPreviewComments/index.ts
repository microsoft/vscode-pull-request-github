/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Script contributed to the built-in markdown preview through `markdown.previewScripts`.
 * It adds commenting affordances to the rendered blocks of pull request files, including in the rendered diff.
 * Comment information is rendered into the preview by the markdown-it plugin in src/view/markdownPreviewComments.ts.
 */

import { installStyles, onMouseMove, render, setHoverTarget } from './overlay';

installStyles();

document.addEventListener('mousemove', onMouseMove);

document.documentElement.addEventListener('mouseleave', () => setHoverTarget(undefined));

let renderScheduled = false;
function scheduleRender(): void {
	if (renderScheduled) {
		return;
	}
	renderScheduled = true;
	requestAnimationFrame(() => {
		renderScheduled = false;
		render();
	});
}

window.addEventListener('vscode.markdown.updateContent', scheduleRender);
window.addEventListener('resize', scheduleRender);
// Images and code blocks can change the layout after the content is rendered.
new ResizeObserver(scheduleRender).observe(document.body);

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', scheduleRender);
} else {
	scheduleRender();
}
