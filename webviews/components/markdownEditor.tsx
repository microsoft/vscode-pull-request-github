/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface MarkdownEditorProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
	renderMarkdown?: (text: string) => Promise<string>;
}

export const MarkdownEditor = React.forwardRef(function MarkdownEditor(
	{ renderMarkdown, ...props }: MarkdownEditorProps,
	forwardedRef: React.Ref<HTMLTextAreaElement>,
) {
	const [mode, setMode] = useState<'write' | 'preview'>('write');
	const [html, setHtml] = useState<string>('');
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const internalRef = useRef<HTMLTextAreaElement>(null);

	const setRefs = useCallback(
		(node: HTMLTextAreaElement) => {
			(internalRef as React.MutableRefObject<HTMLTextAreaElement | null>).current =
				node;
			if (typeof forwardedRef === 'function') {
				forwardedRef(node);
			} else if (forwardedRef) {
				(
					forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>
				).current = node;
			}
		},
		[forwardedRef],
	);

	useEffect(() => {
		if (mode !== 'preview') return;

		if (!renderMarkdown) {
			const text = internalRef.current?.value || '';
			setHtml(text ? `<pre>${text}</pre>` : '<em>Nothing to preview</em>');
			return;
		}

		let cancelled = false;
		setIsLoading(true);

		const text = internalRef.current?.value || '';
		if (!text.trim()) {
			setHtml('');
			setIsLoading(false);
			return;
		}

		renderMarkdown(text)
			.then((rendered) => {
				if (!cancelled) {
					setHtml(rendered);
					setIsLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setHtml('<em>Error rendering preview</em>');
					setIsLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [mode, renderMarkdown]);

	return (
		<div className='markdown-editor'>
			<div className='markdown-editor-tabs'>
				<button
					type='button'
					className={`markdown-editor-tab${mode === 'write' ? ' active' : ''}`}
					onClick={() => setMode('write')}
				>
					Write
				</button>
				<button
					type='button'
					className={`markdown-editor-tab${mode === 'preview' ? ' active' : ''}`}
					onClick={() => setMode('preview')}
					disabled={props.disabled}
				>
					Preview
				</button>
			</div>
			<div className='markdown-editor-content'>
				<textarea
					ref={setRefs}
					style={{ display: mode === 'write' ? 'block' : 'none' }}
					{...props}
				/>
				{mode === 'preview' && (
					<div className='markdown-editor-preview comment-body'>
						{!isLoading && html && <div dangerouslySetInnerHTML={{ __html: html }} />}
						{!isLoading && !html && <em>Nothing to preview</em>}
						{isLoading && <em>Loading preview...</em>}
					</div>
				)}
			</div>
		</div>
	);
});
