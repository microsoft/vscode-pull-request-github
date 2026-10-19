/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThreadContext } from './client';

export function suggestionText(markdown: string): string {
	const suggestions = [...markdown.matchAll(/^```suggestion[ \t]*\r?\n(?<replacement>[\s\S]*?)^```[ \t]*\r?$/gm)];
	if (suggestions.length !== 1 || [...markdown.matchAll(/^```suggestion[^\r\n]*\r?$/gm)].length !== 1) {
		throw new Error('Apply one plain suggestion block at a time. Offset suggestions are not supported.');
	}
	return suggestions[0].groups!.replacement.replace(/\r?\n$/, '');
}

interface Storage {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface DraftComment {
	id: number;
	content: string;
	threadId?: number;
	parentCommentId?: number;
	context?: ThreadContext;
	iteration?: number;
	changeTrackingId?: number;
	createdAt?: string;
}

export interface PendingReview {
	nonce: string;
	author: string;
	commit: string;
	nextId: number;
	comments: DraftComment[];
	summary?: string;
	decision?: 10 | -10 | 0;
}

/** Session-only storage for callers that do not persist state. */
export function memoryStorage(): Storage {
	const values = new Map<string, unknown>();
	return {
		get<T>(key: string, defaultValue: T): T { return values.has(key) ? values.get(key) as T : defaultValue; },
		async update(key: string, value: unknown) { values.set(key, value); },
	};
}

/** Viewed state for changed files, keyed by the source blob that was viewed. */
export class ViewedFiles {
	private readonly storageKey = 'azureDevOps.viewedFiles.v1';
	private operations: Promise<unknown> = Promise.resolve();

	constructor(private readonly storage: Storage) { }

	get(key: string): Record<string, string> {
		return this.storage.get<Record<string, Record<string, string>>>(this.storageKey, {})[key] ?? {};
	}

	set(key: string, update: Record<string, string | undefined>): Promise<void> {
		const result = this.operations.then(async () => {
			const all = { ...this.storage.get<Record<string, Record<string, string>>>(this.storageKey, {}) };
			const files = { ...(all[key] ?? {}) };
			for (const [path, blob] of Object.entries(update)) {
				if (blob === undefined) {
					delete files[path];
				} else {
					files[path] = blob;
				}
			}
			if (Object.keys(files).length) {
				all[key] = files;
			} else {
				delete all[key];
			}
			await this.storage.update(this.storageKey, all);
		});
		this.operations = result.then(() => undefined, () => undefined);
		return result;
	}
}

/** Keep acknowledged posts out of the persisted queue so a failed submission can be resumed. */
export class PendingReviews {
	private operations: Promise<unknown> = Promise.resolve();
	private readonly storageKey = 'azureDevOps.pendingReviews.v1';

	constructor(private readonly storage: Storage) { }

	get(key: string): PendingReview | undefined {
		return this.storage.get<Record<string, PendingReview>>(this.storageKey, {})[key];
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operations.then(operation);
		this.operations = result.then(() => undefined, () => undefined);
		return result;
	}

	private async save(key: string, review: PendingReview | undefined): Promise<void> {
		const reviews = { ...this.storage.get<Record<string, PendingReview>>(this.storageKey, {}) };
		if (review) {
			reviews[key] = review;
		} else {
			delete reviews[key];
		}
		await this.storage.update(this.storageKey, reviews);
	}

	async start(key: string, author: string, commit: string): Promise<void> {
		return this.serialize(async () => {
			const existing = this.get(key);
			if (existing) {
				if (existing.author !== author || existing.commit !== commit) {
					throw new Error('The pending review belongs to another account or source commit. Submit or discard it before starting another review.');
				}
				return;
			}
			await this.save(key, { nonce: crypto.randomUUID(), author, commit, nextId: -1, comments: [] });
		});
	}

	async add(key: string, comment: Omit<DraftComment, 'id'>): Promise<DraftComment> {
		return this.serialize(async () => {
			const review = this.get(key);
			if (!review) {
				throw new Error('Start a review before adding draft comments.');
			}
			if (review.summary !== undefined) {
				throw new Error('Finish or discard the pending submission before adding more draft comments.');
			}
			const draft = { ...comment, id: review.nextId };
			await this.save(key, { ...review, nextId: review.nextId - 1, comments: [...review.comments, draft] });
			return draft;
		});
	}

	async edit(key: string, id: number, content?: string): Promise<void> {
		return this.serialize(async () => {
			const review = this.get(key);
			if (!review?.comments.some(comment => comment.id === id)) {
				throw new Error('The draft comment no longer exists.');
			}
			if (review.summary !== undefined) {
				throw new Error('Finish or discard the pending submission before changing draft comments.');
			}

			await this.save(key, {
				...review,
				comments: content === undefined ? review.comments.filter(comment => comment.id !== id)
					: review.comments.map(comment => comment.id === id ? { ...comment, content } : comment),
			});
		});
	}

	async discard(key: string): Promise<void> {
		return this.serialize(() => this.save(key, undefined));
	}

	async setSummary(key: string, content: string, decision?: 10 | -10 | 0): Promise<void> {
		return this.serialize(async () => {
			const review = this.get(key);
			if (!review) {
				throw new Error('Start a review before adding a summary.');
			}
			if (review.decision !== undefined && review.decision !== decision) {
				throw new Error('The review decision changed during a retry. Finish or discard the pending review first.');
			}
			if (review.summary !== undefined) {
				if (review.summary !== content) {
					throw new Error('The review summary changed during a retry. Finish or discard the pending review first.');
				}
				if (review.decision === undefined && decision !== undefined) {
					await this.save(key, { ...review, decision });
				}
				return;
			}
			await this.save(key, {
				...review,
				summary: content,
				decision,
				nextId: content.trim() ? review.nextId - 1 : review.nextId,
				comments: content.trim() ? [...review.comments, { id: review.nextId, content }] : review.comments,
			});
		});
	}

	async submit(key: string, author: string, commit: string, publish: (comment: DraftComment, marker: string) => Promise<void>, vote: () => Promise<void>): Promise<void> {
		return this.serialize(async () => {
			let review = this.get(key);
			if (!review) {
				throw new Error('There is no pending review to submit.');
			}
			if (review.author !== author || review.commit !== commit) {
				throw new Error('The account or pull request source commit changed. Pending comments were kept; reopen the reviewed iteration or discard the review.');
			}
			while (review.comments.length) {
				const comment = review.comments[0];
				await publish(comment, `<!-- azdo-review:${review.nonce}:${comment.id} -->`);
				review = { ...review, comments: review.comments.slice(1) };
				await this.save(key, review);
			}
			await vote();
			await this.save(key, undefined);
		});
	}
}
