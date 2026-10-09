/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageHandler } from './message';

export interface WebviewHost extends WebviewState {
	postMessage(message: CommandMessage): Promise<unknown>;
	onCommand(listener: (command: unknown) => void): () => void;
	dispose(): void;
}

export function createWebviewHost(transport: WebviewTransport = vscodeTransport): WebviewHost {
	return new MessageHandler(transport);
}

export interface CommandMessage {
	command: string;
	args?: unknown;
}

export interface RequestMessage extends CommandMessage {
	req: string;
}

export interface ReplyMessage {
	seq?: string;
	err?: string;
	res?: unknown;
}

export interface WebviewState {
	getState<T>(): T | undefined;
	setState<T>(state: T): void;
}

export interface WebviewTransport extends WebviewState {
	postMessage(message: RequestMessage): void;
	onMessage(listener: (message: ReplyMessage) => void): () => void;
}

declare function acquireVsCodeApi(): Omit<WebviewTransport, 'onMessage'>;

let api: Omit<WebviewTransport, 'onMessage'> | undefined;

function getApi(): Omit<WebviewTransport, 'onMessage'> {
	api ??= acquireVsCodeApi();
	return api;
}

export const vscodeTransport: WebviewTransport = {
	getState: <T>() => getApi().getState<T>(),
	setState: <T>(state: T) => getApi().setState(state),
	postMessage: message => getApi().postMessage(message),
	onMessage: listener => {
		const handler = (event: MessageEvent<ReplyMessage>) => listener(event.data);
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	},
};
