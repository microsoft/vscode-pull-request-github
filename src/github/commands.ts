/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from './pullRequestModel';
export function getCommentThreadCommands(commentControl: vscode.CommentController, thread: vscode.CommentThread, pullRequestModel: PullRequestModel, inDraftMode: boolean): vscode.Command[] {
	let commands: vscode.Command[] = [];
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

		commands.push({
			title: 'Add Review Comment',
			command: 'pr.replyComment',
			arguments: [
				commentControl,
				thread,
				pullRequestModel
			]
		});
	} else {
		commands.push({
			title: 'Start Review',
			command: 'pr.startReview',
			arguments: [
				commentControl,
				thread,
				pullRequestModel
			]
		});

		commands.push({
			title: 'Reply Comment',
			command: 'pr.replyComment',
			arguments: [
				commentControl,
				thread,
				pullRequestModel
			]
		});
	}

	return commands;
}

export function getEditCommand(commentControl: vscode.CommentController, thread: vscode.CommentThread, pullRequestModel: PullRequestModel, vscodeComment: vscode.Comment): vscode.Command {
	return {
		title: 'Edit Comment',
		command: 'pr.editComment',
		arguments: [
			commentControl,
			thread,
			pullRequestModel,
			vscodeComment
		]
	};
}

export function getDeleteCommand(commentControl: vscode.CommentController, thread: vscode.CommentThread, pullRequestModel: PullRequestModel, vscodeComment: vscode.Comment): vscode.Command {
	return {
		title: 'Delete Comment',
		command: 'pr.deleteComment',
		arguments: [
			commentControl,
			thread,
			pullRequestModel,
			vscodeComment
		]
	};
}