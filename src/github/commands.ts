/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from './pullRequestModel';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { ReviewDocumentCommentProvider } from '../view/reviewDocumentCommentProvider';
export function getCommentThreadCommands(commentControl: vscode.CommentController, thread: vscode.CommentThread, pullRequestModel: PullRequestModel, inDraftMode: boolean, node: PRNode | ReviewDocumentCommentProvider): { acceptInputCommand: vscode.Command, additionalCommands: vscode.Command[] } {
	let commands: vscode.Command[] = [];
	let acceptInputCommand: vscode.Command;
	if (inDraftMode) {
		commands.push({
			title: 'Delete Review',
			command: 'pr.deleteReview',
			arguments: [
				commentControl,
				thread,
				pullRequestModel
			]
		});

		commands.push({
			title: 'Finish Review',
			command: 'pr.finishReview',
			arguments: [
				commentControl,
				thread,
				pullRequestModel
			]
		});

		acceptInputCommand = {
			title: 'Add Review Comment',
			command: 'pr.replyComment',
			arguments: [
				commentControl,
				thread,
				pullRequestModel,
				node
			]
		};
	} else {
		commands.push({
			title: 'Start Review',
			command: 'pr.startReview',
			arguments: [
				commentControl,
				thread,
				pullRequestModel,
				node
			]
		});

		acceptInputCommand = {
			title: 'Reply Comment',
			command: 'pr.replyComment',
			arguments: [
				commentControl,
				thread,
				pullRequestModel,
				node
			]
		};
	}

	return {
		acceptInputCommand: acceptInputCommand,
		additionalCommands: commands
	};
}

export function getEditCommand(commentControl: vscode.CommentController, thread: vscode.CommentThread, vscodeComment: vscode.Comment, node: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Edit Comment',
		command: 'pr.editComment',
		arguments: [
			commentControl,
			thread,
			vscodeComment,
			node
		]
	};
}

export function getDeleteCommand(commentControl: vscode.CommentController, thread: vscode.CommentThread, vscodeComment: vscode.Comment, node: PRNode | ReviewDocumentCommentProvider): vscode.Command {
	return {
		title: 'Delete Comment',
		command: 'pr.deleteComment',
		arguments: [
			commentControl,
			thread,
			vscodeComment,
			node
		]
	};
}