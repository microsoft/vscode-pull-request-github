/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiffRange, DiffRangePreset, DiffRangeUnavailableReason, DiffRangeWarning, shortSha } from '../github/diffRange';

export function diffRangePresetTitle(preset: DiffRangePreset): string {
	switch (preset) {
		case 'all':
			return vscode.l10n.t('All changes');
		case 'sinceLastReview':
			return vscode.l10n.t('Since my last review');
		case 'sinceLastComment':
			return vscode.l10n.t('Since my last comment');
		case 'sinceEarliestUnresolvedThread':
			return vscode.l10n.t('Since the earliest unresolved thread');
		case 'custom':
			return vscode.l10n.t('Custom range');
	}
}

/**
 * A short, lower-case label for use after a commit range, e.g. "a1b2c3d..d4e5f6a · since my last review".
 */
export function diffRangePresetLabel(preset: DiffRangePreset): string {
	switch (preset) {
		case 'all':
			return vscode.l10n.t('all changes');
		case 'sinceLastReview':
			return vscode.l10n.t('since my last review');
		case 'sinceLastComment':
			return vscode.l10n.t('since my last comment');
		case 'sinceEarliestUnresolvedThread':
			return vscode.l10n.t('since earliest unresolved thread');
		case 'custom':
			return vscode.l10n.t('custom range');
	}
}

export function diffRangeUnavailableMessage(reason: DiffRangeUnavailableReason): string {
	switch (reason) {
		case 'noReview':
			return vscode.l10n.t('You have not reviewed this pull request yet');
		case 'reviewAtHead':
			return vscode.l10n.t('There are no changes since your last review');
		case 'noViewer':
			return vscode.l10n.t('Sign in to GitHub to use this option');
		case 'noOwnComment':
			return vscode.l10n.t('You have not commented on this pull request yet');
		case 'commentAtHead':
			return vscode.l10n.t('There are no changes since your last comment');
		case 'noUnresolvedThread':
			return vscode.l10n.t('There are no unresolved threads');
		case 'threadAtHead':
			return vscode.l10n.t('There are no changes since the earliest unresolved thread');
	}
}

export function diffRangeWarningMessage(warning: DiffRangeWarning): string {
	switch (warning) {
		case 'baseNotInPullRequest':
			return vscode.l10n.t('The base commit is no longer part of this pull request. It may have been force pushed.');
		case 'baseNotAncestor':
			return vscode.l10n.t('The base commit is not an ancestor of the head commit. Changes are shown from their merge base instead.');
		case 'presetUnavailable':
			return vscode.l10n.t('The selected range is not available for this pull request. All changes are shown instead.');
	}
}

/**
 * Describes a non-default diff range as "base..head · label". Returns `undefined` for the default range.
 * @param baseSha The base actually used for the comparison, when known (i.e. the merge base returned by GitHub).
 */
export function describeDiffRange(range: DiffRange, baseSha: string | undefined, headSha: string | undefined): string | undefined {
	if (range.preset === 'all') {
		return undefined;
	}
	const base = baseSha ?? range.baseSha;
	const head = range.headSha ?? headSha;
	const label = diffRangePresetLabel(range.preset);
	if (!base || !head) {
		return label;
	}
	// allow-any-unicode-next-line
	return `${shortSha(base)}..${shortSha(head)} · ${label}`;
}
