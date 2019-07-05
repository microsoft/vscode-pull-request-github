declare module 'jsdom-global' {
	export = install;

	namespace install {
		export interface JSDomOptions {
			url?: string;
			referrer?: string;
			contentType?: string;
			includeNodeLocations?: boolean;
			storageQuota?: number;
			runScripts?: 'outside-only' | 'dangerously';
		}
	}

	function install(markup?: string, options?: install.JSDomOptions): () => void;
}