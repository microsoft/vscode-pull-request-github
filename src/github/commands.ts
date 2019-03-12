/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { ReviewDocumentCommentProvider } from '../view/reviewDocumentCommentProvider';
import { CommentHandler } from '../common/comment';
export function getCommentThreadCommands(thread: vscode.CommentThread, inDraftMode: boolean, node: CommentHandler): { acceptInputCommand: vscode.Command, additionalCommands: vscode.Command[] } {
	let commands: vscode.Command[] = [];
	let acceptInputCommand: vscode.Command;
	if (inDraftMode) {
		commands.push({
			title: 'Delete Review',
			command: 'pr.deleteReview',
			arguments: [
				node
			]
		});

		commands.push({
			title: 'Finish Review',
			command: 'pr.finishReview',
			arguments: [
				node,
				thread
			]
		});

		acceptInputCommand = {
			title: 'Add Review Comment',
			command: 'pr.replyComment',
			arguments: [
				node,
				thread
			]
		};
	} else {
		commands.push({
			title: 'Start Review',
			command: 'pr.startReview',
			arguments: [
				node,
				thread
			]
		});

		acceptInputCommand = {
			title: 'Reply Comment',
			command: 'pr.replyComment',
			arguments: [
				node,
				thread
			]
		};
	}

	return {
		acceptInputCommand: acceptInputCommand,
		additionalCommands: commands
	};
}

export function getEditCommand(thread: vscode.CommentThread, vscodeComment: vscode.Comment, node: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Edit Comment',
		command: 'pr.editComment',
		arguments: [
			node,
			thread,
			vscodeComment
		]
	};
}

export function getDeleteCommand(thread: vscode.CommentThread, vscodeComment: vscode.Comment, node: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Delete Comment',
		command: 'pr.deleteComment',
		arguments: [
			node,
			thread,
			vscodeComment
		]
	};
}