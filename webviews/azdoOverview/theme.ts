/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * azure-devops-ui reads its colours from CSS custom properties, several of which are raw
 * "r, g, b" triples. VS Code exposes hex colours, so the theme is derived at runtime and
 * recomputed whenever VS Code switches theme (it rewrites the body class).
 */

type RGB = [number, number, number];

const probe = document.createElement('span');

function resolve(name: string, fallback: string): RGB {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
	probe.style.color = '';
	probe.style.color = value;
	if (!probe.isConnected) {
		probe.style.display = 'none';
		document.body.appendChild(probe);
	}
	const match = getComputedStyle(probe).color.match(/[\d.]+/g);
	return match ? [Number(match[0]), Number(match[1]), Number(match[2])] : [128, 128, 128];
}

const mix = (from: RGB, to: RGB, amount: number): RGB =>
	from.map((value, index) => Math.round(value + (to[index] - value) * amount)) as RGB;
const triple = (color: RGB) => color.join(', ');
const rgba = (color: RGB, alpha = 1) => `rgba(${triple(color)}, ${alpha})`;

export function applyTheme(): void {
	const background = resolve('--vscode-editor-background', '#ffffff');
	const surface = resolve('--vscode-editorWidget-background', '#f3f3f3');
	const foreground = resolve('--vscode-foreground', '#333333');
	const secondary = resolve('--vscode-descriptionForeground', '#717171');
	const disabled = resolve('--vscode-disabledForeground', '#a0a0a0');
	const link = resolve('--vscode-textLink-foreground', '#006ab1');
	const primary = resolve('--vscode-button-background', '#007acc');
	const onPrimary = resolve('--vscode-button-foreground', '#ffffff');
	const focus = resolve('--vscode-focusBorder', '#0090f1');
	const menu = resolve('--vscode-menu-background', '#ffffff');
	const error = resolve('--vscode-errorForeground', '#e51400');
	const warning = resolve('--vscode-editorWarning-foreground', '#bf8803');
	const success = resolve('--vscode-testing-iconPassed', '#73c991');
	const info = resolve('--vscode-editorInfo-foreground', '#1a85ff');

	const vars: Record<string, string> = {
		'--background-color': rgba(background),
		'--callout-background-color': rgba(surface),
		'--text-primary-color': rgba(foreground),
		'--text-secondary-color': rgba(secondary),
		'--text-disabled-color': rgba(disabled),
		'--communication-foreground': rgba(link),
		'--communication-background': rgba(primary),
		'--text-on-communication-background': rgba(onPrimary),
		'--focus-border-color': rgba(focus),
		'--component-grid-focus-border-color': rgba(focus),
		'--focus-pulse-max-color': rgba(focus, 0.23),
		'--callout-shadow-color': rgba(foreground, 0.13),
		'--callout-shadow-secondary-color': rgba(foreground, 0.1),
		'--panel-shadow-color': rgba(foreground, 0.22),
		'--panel-shadow-secondary-color': rgba(foreground, 0.18),
		'--component-grid-row-hover-color': rgba(foreground, 0.04),
		'--component-grid-selected-row-color': rgba(primary, 0.2),
		'--component-grid-cell-bottom-border-color': rgba(mix(surface, foreground, 0.1)),
		'--component-label-default-color': rgba(mix(surface, foreground, 0.06)),
		'--component-label-default-color-hover': rgba(mix(surface, foreground, 0.14)),
		'--status-error-text': rgba(error),
		'--status-error-foreground': rgba(error),
		'--status-error-strong': rgba(error),
		'--status-error-background': rgba(error, 0.12),
		'--status-warning-text': rgba(warning),
		'--status-warning-icon-foreground': rgba(warning),
		'--status-warning-background': rgba(warning, 0.12),
		'--status-success-foreground': rgba(success),
		'--status-success-background': rgba(success, 0.12),
		'--status-info-foreground': rgba(info),
		'--component-status-error': rgba(error),
		'--component-status-warning': rgba(warning),
		'--component-status-success': rgba(success),
		'--component-status-info': rgba(info),
		'--component-status-neutral': rgba(secondary),
		'--palette-error': rgba(error),
		'--palette-error-6': rgba(mix(error, foreground, 0.06)),
		'--palette-error-10': rgba(mix(error, foreground, 0.1)),
		'--palette-accent3': triple(warning),
		'--palette-primary': triple(primary),
		'--palette-primary-darkened-6': triple(mix(primary, foreground, 0.06)),
		'--palette-primary-darkened-10': triple(mix(primary, foreground, 0.1)),
		'--palette-primary-shade-10': triple(mix(primary, foreground, 0.1)),
		'--palette-primary-shade-20': triple(mix(primary, foreground, 0.2)),
		'--palette-primary-shade-30': triple(mix(primary, foreground, 0.3)),
		'--palette-primary-tint-10': triple(mix(primary, background, 0.15)),
		'--palette-primary-tint-20': triple(mix(primary, background, 0.7)),
		'--palette-primary-tint-30': triple(mix(primary, background, 0.82)),
		'--palette-primary-tint-40': triple(mix(primary, background, 0.92)),
		'--azdo-menu-background': rgba(menu),
	};
	for (const step of [0, 2, 4, 6, 8, 10, 20, 30, 80, 100]) {
		vars[`--palette-neutral-${step}`] = triple(mix(surface, foreground, step / 100));
	}
	for (const step of [2, 4, 6, 8, 10, 20, 30, 60]) {
		vars[`--palette-black-alpha-${step}`] = rgba(foreground, step / 100);
	}
	const root = document.documentElement.style;
	for (const [name, value] of Object.entries(vars)) {
		root.setProperty(name, value);
	}
}

export function watchTheme(): void {
	applyTheme();
	new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
