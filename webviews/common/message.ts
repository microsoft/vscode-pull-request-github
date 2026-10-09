/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CommandMessage, ReplyMessage, WebviewHost, WebviewTransport } from './host';

let lastSentReq = 0;

export class MessageHandlerDisposedError extends Error {
	constructor() {
		super('The webview message handler has been disposed.');
	}
}

export function rethrowUnlessDisposed(error: unknown): void {
	if (!(error instanceof MessageHandlerDisposedError)) {
		throw error;
	}
}

export class MessageHandler implements WebviewHost {
	private readonly _commandListeners = new Set<(command: unknown) => void>();
	private readonly _pendingReplies = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
	private readonly _unsubscribe: () => void;
	private _disposed = false;

	constructor(private readonly _transport: WebviewTransport) {
		this._unsubscribe = _transport.onMessage(this._handleMessage);
	}

	public getState<T>(): T | undefined {
		return this._transport.getState<T>();
	}

	public setState<T>(state: T): void {
		this._transport.setState(state);
	}

	public onCommand(listener: (command: unknown) => void): () => void {
		if (this._disposed) {
			throw new MessageHandlerDisposedError();
		}
		this._commandListeners.add(listener);
		return () => this._commandListeners.delete(listener);
	}

	public async postMessage(message: CommandMessage): Promise<unknown> {
		if (this._disposed) {
			throw new MessageHandlerDisposedError();
		}
		const req = String(++lastSentReq);
		return new Promise<unknown>((resolve, reject) => {
			this._pendingReplies.set(req, { resolve, reject });
			try {
				this._transport.postMessage({ ...message, req });
			} catch (error) {
				this._pendingReplies.delete(req);
				reject(error);
			}
		});
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._unsubscribe();
		this._commandListeners.clear();
		for (const reply of this._pendingReplies.values()) {
			reply.reject(new MessageHandlerDisposedError());
		}
		this._pendingReplies.clear();
	}

	private _handleMessage = (message: ReplyMessage) => {
		if (message.seq) {
			const pendingReply = this._pendingReplies.get(message.seq);
			if (pendingReply) {
				this._pendingReplies.delete(message.seq);
				if (message.err) {
					pendingReply.reject(message.err);
				} else {
					pendingReply.resolve(message.res);
				}
			}
			return;
		}

		for (const listener of this._commandListeners) {
			listener(message.res);
		}
	};
}
