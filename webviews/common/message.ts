/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IRequestMessage<T> {
	req: string;
	command: string;
	args: T;
}

interface IReplyMessage {
	seq: string;
	err: any;
	res: any;
}

declare var acquireVsCodeApi: any;
export const vscode = acquireVsCodeApi();

export class MessageHandler {
	private _commandHandler: ((message: any) => void) | null;
	private lastSentReq: number;
	private pendingReplies: any;
	constructor(commandHandler: any) {
		this._commandHandler = commandHandler;
		this.lastSentReq = 0;
		this.pendingReplies = Object.create(null);
		window.addEventListener('message', this.handleMessage.bind(this));
	}

	public registerCommandHandler(commandHandler: (message: any) => void) {
		this._commandHandler = commandHandler;
	}

	public async postMessage(message: any): Promise<any> {
		const req = String(++this.lastSentReq);
		return new Promise<any>((resolve, reject) => {
			this.pendingReplies[req] = {
				resolve: resolve,
				reject: reject
			};
			message = Object.assign(message, {
				req: req
			});
			vscode.postMessage(message as IRequestMessage<any>);
		});
	}

	// handle message should resolve promises
	private handleMessage(event: any) {
		const message: IReplyMessage = event.data; // The json data that the extension sent
		if (message.seq) {
			// this is a reply
			const pendingReply = this.pendingReplies[message.seq];
			if (pendingReply) {
				if (message.err) {
					pendingReply.reject(message.err);
				} else {
					pendingReply.resolve(message.res);
				}
				return;
			}
		}

		if (this._commandHandler) {
			this._commandHandler(message.res);
		}
	}
}

export function getMessageHandler(handler: ((message: any) => void) | null) {
	return new MessageHandler(handler);
}