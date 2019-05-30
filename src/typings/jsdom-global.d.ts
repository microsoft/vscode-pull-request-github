declare module 'jsdom-global' {
	export interface JSDomOptions {
		url?: string;
		referrer?: string;
		contentType?: string;
		includeNodeLocations?: boolean;
		storageQuota?: number;
		runScripts?: 'outside-only' | 'dangerously';
	}

	export default function (markup?: string, options?: JSDomOptions): () => void;
}