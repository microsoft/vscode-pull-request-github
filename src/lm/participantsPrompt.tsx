/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AssistantMessage, BasePromptElementProps, PrioritizedList, PromptElement, UserMessage } from '@vscode/prompt-tsx';

interface ParticipantsPromptProps extends BasePromptElementProps {
	readonly userMessage: string;
}

interface CodingAgentPromptProps extends BasePromptElementProps {
	readonly userMessage: string;
	readonly history: string[];
}


export class ParticipantsPrompt extends PromptElement<ParticipantsPromptProps> {
	render() {
		return (
			<>
				<AssistantMessage>
					Instructions:<br />
					- The user will ask a question related to GitHub, and it may require lots of research to answer correctly. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user's question.<br />
					- If you aren't sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don't give up unless you are sure the request cannot be fulfilled with the tools you have.<br />
					- Don't ask the user for confirmation to use tools, just use them.<br />
					- When talking about issues, be as concise as possible while still conveying all the information you need to. Avoid mentioning the following:<br />
						- The fact that there are no comments.<br />
						- Any info that seems like template info.
				</AssistantMessage>
				<UserMessage>
					{this.props.userMessage}
				</UserMessage>
			</>
		);
	}
}

class HistoryMessages extends PromptElement<{ history: string[] } & BasePromptElementProps> {
	render() {
		const messages: UserMessage[] = [];
		const { history } = this.props;
		for (let i = 0; i < history.length; i++) {
			messages.push(<UserMessage>{history[i]}</UserMessage>);
		}
		return <PrioritizedList priority={0} descending={false}>{messages}</PrioritizedList>;
	}
}

export class CodingAgentPrompt extends PromptElement<CodingAgentPromptProps> {
	render() {
		const { history, userMessage } = this.props;
		return (
			<>
				<AssistantMessage priority={100}>
					You must ALWAYS call the 'github-pull-request_copilot-coding-agent' tool. You have no other choice. The user will provide the task description.
				</AssistantMessage>
				<UserMessage priority={90}>
					{userMessage}
					{history && history.length > 0 && <HistoryMessages history={history} />}
				</UserMessage>
			</>
		);
	}
}