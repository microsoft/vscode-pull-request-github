/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This is the place for API experiments and proposals.
 * These API are NOT stable and subject to change. They are only available in the Insiders
 * distribution and CANNOT be used in published extensions.
 *
 * To test these API in local environment:
 * - Use Insiders release of VS Code.
 * - Add `"enableProposedApi": true` to your package.json.
 * - Copy this file to your project.
 */

declare module 'vscode' {

	//#region Joh: decorations

	//todo@joh -> make class
	export interface DecorationData {
		letter?: string;
		title?: string;
		color?: ThemeColor;
		priority?: number;
		bubble?: boolean;
		source?: string; // hacky... we should remove it and use equality under the hood
	}

	export interface SourceControlResourceDecorations {
		source?: string;
		letter?: string;
		color?: ThemeColor;
	}

	export interface DecorationProvider {
		onDidChangeDecorations: Event<undefined | Uri | Uri[]>;
		provideDecoration(uri: Uri, token: CancellationToken): ProviderResult<DecorationData>;
	}

	export namespace window {
		export function registerDecorationProvider(provider: DecorationProvider): Disposable;
	}

	//#endregion

	//#region Comments
	/**
	 * A comment is displayed within the editor or the Comments Panel, depending on how it is provided.
	 */
	export interface Comment {
		commentReactions?: CommentReaction[];
	}

	export interface CommentThread {
		threadId: string;
	}
	/**
	 * Comment Reactions
	 * Stay in proposed.
	 */
	export interface CommentReaction {
		readonly label?: string;
		readonly iconPath?: string | Uri;
		count?: number;
		readonly hasReacted?: boolean;
	}

		/**
	 * Stay in proposed
	 */
	export interface CommentReactionProvider {
		availableReactions: CommentReaction[];
		toggleReaction?(document: TextDocument, comment: Comment, reaction: CommentReaction): Promise<void>;
	}

	/**
	 * A comment controller is able to provide [comments](#CommentThread) support to the editor and
	 * provide users various ways to interact with comments.
	 */
	export interface CommentController {
		/**
		 * Optional reaction provider
		 */
		reactionProvider?: CommentReactionProvider;
	}

	//#endregion

}
