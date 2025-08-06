/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import vscode from 'vscode';
import { parseSessionLogs, parseToolCallDetails } from '../../../common/sessionParsing';
import Logger from '../../common/logger';
import { CommentEvent, CopilotFinishedEvent, CopilotStartedEvent, EventType, ReviewEvent, TimelineEvent } from '../../common/timelineEvent';
import { InMemFileChangeModel, RemoteFileChangeModel } from '../../view/fileChangeModel';
import { AssistantDelta, Choice } from '../common';
import { CopilotApi, SessionInfo } from '../copilotApi';
import { PullRequestModel } from '../pullRequestModel';

export class ChatSessionContentBuilder {
	constructor(
		private loggerId: string,
		private readonly handler: string,
		private getChangeModels: () => Promise<(RemoteFileChangeModel | InMemFileChangeModel)[]>
	) { }

	public async buildSessionHistory(
		sessions: SessionInfo[],
		pullRequest: PullRequestModel,
		capi: CopilotApi
	): Promise<Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2>> {
		const sortedSessions = sessions.slice().sort((a, b) =>
			new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
		);

		const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
		const timelineEvents = await pullRequest.getTimelineEvents(pullRequest);

		Logger.appendLine(`Found ${timelineEvents.length} timeline events`, this.loggerId);

		for (const [sessionIndex, session] of sortedSessions.entries()) {
			const logs = await capi.getLogsFromSession(session.id);
			const sessionPrompt = await this.determineSessionPrompt(session, sessionIndex, pullRequest, timelineEvents, capi);

			// Create request turn for this session
			const sessionRequest = new vscode.ChatRequestTurn2(
				sessionPrompt,
				undefined, // command
				[], // references
				'copilot-swe-agent',
				[], // toolReferences
				[]
			);
			history.push(sessionRequest);

			// Create response turn
			const responseHistory = await this.createResponseTurn(pullRequest, logs, session);
			if (responseHistory) {
				history.push(responseHistory);
			}
		}

		return history;
	}

	private async createResponseTurn(pullRequest: PullRequestModel, logs: string, session: SessionInfo): Promise<vscode.ChatResponseTurn2 | undefined> {
		if (logs.trim().length > 0) {
			return await this.parseSessionLogsIntoResponseTurn(pullRequest, logs, session);
		} else if (session.state === 'in_progress') {
			// For in-progress sessions without logs, create a placeholder response
			const placeholderParts = [new vscode.ChatResponseProgressPart('Session is initializing...')];
			const responseResult: vscode.ChatResult = {};
			return new vscode.ChatResponseTurn2(placeholderParts, responseResult, 'copilot-swe-agent');
		} else {
			// For completed sessions without logs, add an empty response to maintain pairing
			const emptyParts = [new vscode.ChatResponseMarkdownPart('_No logs available for this session_')];
			const responseResult: vscode.ChatResult = {};
			return new vscode.ChatResponseTurn2(emptyParts, responseResult, 'copilot-swe-agent');
		}
	}

	private async determineSessionPrompt(
		session: SessionInfo,
		sessionIndex: number,
		pullRequest: PullRequestModel,
		timelineEvents: readonly TimelineEvent[],
		capi: CopilotApi
	): Promise<string> {
		let sessionPrompt = session.name || `Session ${sessionIndex + 1} (ID: ${session.id})`;

		if (sessionIndex === 0) {
			sessionPrompt = await this.getInitialSessionPrompt(session, pullRequest, capi, sessionPrompt);
		} else {
			sessionPrompt = await this.getFollowUpSessionPrompt(sessionIndex, timelineEvents, sessionPrompt);
		}

		// TODO: @rebornix, remove @copilot prefix from session prompt for now
		sessionPrompt = sessionPrompt.replace(/@copilot\s*/gi, '').trim();
		return sessionPrompt;
	}

	private async getFollowUpSessionPrompt(
		sessionIndex: number,
		timelineEvents: readonly TimelineEvent[],
		defaultPrompt: string
	): Promise<string> {
		const copilotStartedEvents = timelineEvents
			.filter((event): event is CopilotStartedEvent => event.event === EventType.CopilotStarted)
			.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

		const copilotFinishedEvents = timelineEvents
			.filter((event): event is CopilotFinishedEvent => event.event === EventType.CopilotFinished)
			.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

		Logger.appendLine(`Session ${sessionIndex}: Found ${copilotStartedEvents.length} CopilotStarted events and ${copilotFinishedEvents.length} CopilotFinished events`, this.loggerId);

		const copilotStartedEvent = copilotStartedEvents[sessionIndex];
		if (!copilotStartedEvent) {
			Logger.appendLine(`Session ${sessionIndex}: No CopilotStarted event found at index ${sessionIndex}`, this.loggerId);
			return defaultPrompt;
		}

		const currentSessionStartTime = new Date(copilotStartedEvent.createdAt).getTime();
		const previousSessionEndTime = this.getPreviousSessionEndTime(sessionIndex, copilotFinishedEvents);

		const relevantEvents = this.findRelevantTimelineEvents(timelineEvents, previousSessionEndTime, currentSessionStartTime);

		const matchingEvent = relevantEvents[0];
		if (matchingEvent) {
			const prompt = this.extractPromptFromEvent(matchingEvent);
			Logger.appendLine(`Session ${sessionIndex}: Found matching event - ${matchingEvent.event}`, this.loggerId);
			return prompt;
		} else {
			Logger.appendLine(`Session ${sessionIndex}: No matching event found between times ${previousSessionEndTime} and ${currentSessionStartTime}`, this.loggerId);
			Logger.appendLine(`Session ${sessionIndex}: Relevant events found: ${relevantEvents.length}`, this.loggerId);
			return defaultPrompt;
		}
	}

	private getPreviousSessionEndTime(sessionIndex: number, copilotFinishedEvents: CopilotFinishedEvent[]): number {
		if (sessionIndex > 0 && copilotFinishedEvents[sessionIndex - 1]) {
			return new Date(copilotFinishedEvents[sessionIndex - 1].createdAt).getTime();
		}
		return 0;
	}

	private findRelevantTimelineEvents(
		timelineEvents: readonly TimelineEvent[],
		previousSessionEndTime: number,
		currentSessionStartTime: number
	): TimelineEvent[] {
		return timelineEvents
			.filter(event => {
				if (event.event !== EventType.Commented && event.event !== EventType.Reviewed) {
					return false;
				}

				const eventTime = new Date(
					event.event === EventType.Commented ? (event as CommentEvent).createdAt :
						event.event === EventType.Reviewed ? (event as ReviewEvent).submittedAt : ''
				).getTime();

				// Must be after previous session and before current session
				return eventTime > previousSessionEndTime && eventTime < currentSessionStartTime;
			})
			.filter(event => {
				if (event.event === EventType.Commented) {
					const comment = event as CommentEvent;
					return comment.body.includes('@copilot') || comment.body.includes(this.handler);
				} else if (event.event === EventType.Reviewed) {
					const review = event as ReviewEvent;
					return review.body.includes('@copilot') || review.body.includes(this.handler);
				}
				return false;
			})
			.sort((a, b) => {
				const timeA = new Date(
					a.event === EventType.Commented ? (a as CommentEvent).createdAt :
						a.event === EventType.Reviewed ? (a as ReviewEvent).submittedAt : ''
				).getTime();
				const timeB = new Date(
					b.event === EventType.Commented ? (b as CommentEvent).createdAt :
						b.event === EventType.Reviewed ? (b as ReviewEvent).submittedAt : ''
				).getTime();
				return timeB - timeA; // Most recent first (closest to session start)
			});
	}

	private extractPromptFromEvent(event: TimelineEvent): string {
		let body = '';
		if (event.event === EventType.Commented) {
			body = (event as CommentEvent).body;
		} else if (event.event === EventType.Reviewed) {
			body = (event as ReviewEvent).body;
		}

		// Extract the prompt before any separator pattern (used in addFollowUpToExistingPR)
		// but keep the @copilot mention
		const separatorMatch = body.match(/^(.*?)\s*\n\n\s*---\s*\n\n/s);
		if (separatorMatch) {
			return separatorMatch[1].trim();
		}

		return body.trim();
	}

	private async getInitialSessionPrompt(
		session: SessionInfo,
		pullRequest: PullRequestModel,
		capi: CopilotApi,
		defaultPrompt: string
	): Promise<string> {
		try {
			const jobInfo = await capi.getJobBySessionId(
				pullRequest.base.repositoryCloneUrl.owner,
				pullRequest.base.repositoryCloneUrl.repositoryName,
				session.id
			);
			if (jobInfo && jobInfo.problem_statement) {
				let prompt = jobInfo.problem_statement;
				const titleMatch = jobInfo.problem_statement.match(/TITLE: \s*(.*)/i);
				if (titleMatch && titleMatch[1]) {
					prompt = titleMatch[1].trim();
				}
				Logger.appendLine(`Session 0: Found problem_statement from Jobs API: ${prompt}`, this.loggerId);
				return prompt;
			}
		} catch (error) {
			Logger.warn(`Failed to get job info for session ${session.id}: ${error}`, this.loggerId);
		}
		return defaultPrompt;
	}

	private async parseSessionLogsIntoResponseTurn(pullRequest: PullRequestModel, logs: string, session: SessionInfo): Promise<vscode.ChatResponseTurn2 | undefined> {
		try {
			const logChunks = parseSessionLogs(logs);
			const responseParts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatToolInvocationPart | vscode.ChatResponseMultiDiffPart> = [];
			let currentResponseContent = '';

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;
					if (delta.role === 'assistant') {
						this.processAssistantDelta(delta, choice, pullRequest, responseParts, currentResponseContent);
					}

				}
			}

			if (currentResponseContent.trim()) {
				responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
			}

			if (session.state === 'completed' || session.state === 'failed' /** session can fail with proposed changes */) {
				const fileChangesPart = await this.getFileChangesMultiDiffPart(pullRequest);
				if (fileChangesPart) {
					responseParts.push(fileChangesPart);
				}
			}

			if (responseParts.length > 0) {
				const responseResult: vscode.ChatResult = {};
				return new vscode.ChatResponseTurn2(responseParts, responseResult, 'copilot-swe-agent');
			}

			return undefined;
		} catch (error) {
			Logger.error(`Failed to parse session logs into response turn: ${error}`, this.loggerId);
			return undefined;
		}
	}

	private processAssistantDelta(
		delta: AssistantDelta,
		choice: Choice,
		pullRequest: PullRequestModel,
		responseParts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatToolInvocationPart | vscode.ChatResponseMultiDiffPart>,
		currentResponseContent: string,
	): string {
		if (delta.role === 'assistant') {
			// Handle special case for run_custom_setup_step
			if (
				choice.finish_reason === 'tool_calls' &&
				delta.tool_calls?.length &&
				delta.tool_calls[0].function.name === 'run_custom_setup_step'
			) {
				const toolCall = delta.tool_calls[0];
				let args: any = {};
				try {
					args = JSON.parse(toolCall.function.arguments);
				} catch {
					// fallback to empty args
				}

				// Ignore if delta.content is empty/undefined (running state)
				if (delta.content && delta.content.trim()) {
					// Add any accumulated content as markdown first
					if (currentResponseContent.trim()) {
						responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
						currentResponseContent = '';
					}

					const toolPart = this.createToolInvocationPart(pullRequest, toolCall, args.name || delta.content);
					if (toolPart) {
						responseParts.push(toolPart);
					}
				}
				// Skip if content is empty (running state)
			} else {
				if (delta.content) {
					if (!delta.content.startsWith('<pr_title>')) {
						currentResponseContent += delta.content;
					}
				}

				if (delta.tool_calls) {
					// Add any accumulated content as markdown first
					if (currentResponseContent.trim()) {
						responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
						currentResponseContent = '';
					}

					for (const toolCall of delta.tool_calls) {
						const toolPart = this.createToolInvocationPart(pullRequest, toolCall, delta.content || '');
						if (toolPart) {
							responseParts.push(toolPart);
						}
					}
				}
			}
		}
		return currentResponseContent;
	}

	private createToolInvocationPart(pullRequest: PullRequestModel, toolCall: any, deltaContent: string = ''): vscode.ChatToolInvocationPart | undefined {
		if (!toolCall.function?.name || !toolCall.id) {
			return undefined;
		}

		// Hide reply_to_comment tool
		if (toolCall.function.name === 'reply_to_comment') {
			return undefined;
		}

		const toolPart = new vscode.ChatToolInvocationPart(toolCall.function.name, toolCall.id);
		toolPart.isComplete = true;
		toolPart.isError = false;
		toolPart.isConfirmed = true;

		try {
			const toolDetails = parseToolCallDetails(toolCall, deltaContent);
			toolPart.toolName = toolDetails.toolName;

			if (toolCall.function.name === 'bash') {
				toolPart.invocationMessage = new vscode.MarkdownString(`\`\`\`bash\n${toolDetails.invocationMessage}\n\`\`\``);
			} else {
				toolPart.invocationMessage = new vscode.MarkdownString(toolDetails.invocationMessage);
			}

			if (toolDetails.pastTenseMessage) {
				toolPart.pastTenseMessage = new vscode.MarkdownString(toolDetails.pastTenseMessage);
			}
			if (toolDetails.originMessage) {
				toolPart.originMessage = new vscode.MarkdownString(toolDetails.originMessage);
			}
			if (toolDetails.toolSpecificData) {
				if ('command' in toolDetails.toolSpecificData) {
					if ((toolDetails.toolSpecificData.command === 'view' || toolDetails.toolSpecificData.command === 'edit') && toolDetails.toolSpecificData.fileLabel) {
						const uri = vscode.Uri.file(nodePath.join(pullRequest.githubRepository.rootUri.fsPath, toolDetails.toolSpecificData.fileLabel));
						toolPart.invocationMessage = new vscode.MarkdownString(`${toolPart.toolName} [](${uri.toString()})`);
						toolPart.invocationMessage.supportHtml = true;
						toolPart.pastTenseMessage = new vscode.MarkdownString(`${toolPart.toolName} [](${uri.toString()})`);
					}
				} else {
					toolPart.toolSpecificData = toolDetails.toolSpecificData;
				}
			}
		} catch (error) {
			toolPart.toolName = toolCall.function.name || 'unknown';
			toolPart.invocationMessage = new vscode.MarkdownString(`Tool: ${toolCall.function.name}`);
			toolPart.isError = true;
		}

		return toolPart;
	}

	private async getFileChangesMultiDiffPart(pullRequest: PullRequestModel): Promise<vscode.ChatResponseMultiDiffPart | undefined> {
		try {
			const changeModels = await this.getChangeModels();

			if (changeModels.length === 0) {
				return undefined;
			}

			const diffEntries: vscode.ChatResponseDiffEntry[] = [];
			for (const changeModel of changeModels) {
				diffEntries.push({
					originalUri: changeModel.parentFilePath,
					modifiedUri: changeModel.filePath,
					goToFileUri: changeModel.filePath
				});
			}

			const title = `Changes in Pull Request #${pullRequest.number}`;
			return new vscode.ChatResponseMultiDiffPart(diffEntries, title);
		} catch (error) {
			Logger.error(`Failed to get file changes multi diff part: ${error}`, this.loggerId);
			return undefined;
		}
	}
}