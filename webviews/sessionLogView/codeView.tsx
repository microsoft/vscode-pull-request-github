/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as monaco from 'monaco-editor';
import * as React from 'react';

const collapsedHeight = 100;

interface CodeViewProps {
	label: string;
	description?: string;
	content: {
		value: string;
		lang: string;
	};
}

export const CodeView: React.FC<CodeViewProps> = ({ label, description, content }) => {
	const [open, setOpen] = React.useState<boolean>(true);
	const [expanded, setExpanded] = React.useState<boolean>(false);
	const [editor, setEditor] = React.useState<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);

	const editorContainerRef = React.useRef<HTMLDivElement>(null);
	const contentRef = React.useRef<HTMLDivElement>(null);

	// Initialize editor when component mounts
	React.useEffect(() => {
		if (!editorContainerRef.current) {
			return;
		}

		const editor = monaco.editor.create(editorContainerRef.current, {
			value: content.value,
			language: content.lang || 'plaintext',
			readOnly: true,
			theme: 'vscode-theme',
			bracketPairColorization: { enabled: false },
			overflowWidgetsDomNode: editorContainerRef.current.parentElement!,
			minimap: { enabled: false },
			scrollbar: {
				vertical: 'hidden',
				horizontal: 'hidden',
				alwaysConsumeMouseWheel: false,
			},
			scrollBeyondLastLine: false,
			lineNumbers: 'off',
			renderLineHighlight: 'none',
			automaticLayout: true,
			fontSize: 12,
			wordWrap: 'on',
			rulers: [],
			overviewRulerLanes: 0,
			renderFinalNewline: 'off',
			stickyScroll: { enabled: false }
		});

		setEditor(editor);
		updateEditorHeight(editor);

		// Cleanup
		return () => {
			if (editor) {
				editor.dispose();
				setEditor(undefined);
			}
		};
	}, [editorContainerRef]);

	// Update editor height when expanded state changes
	React.useEffect(() => {
		if (editor) {
			updateEditorHeight(editor);
		}
	}, [expanded]);

	const updateEditorHeight = (editorInstance: monaco.editor.IStandaloneCodeEditor) => {
		if (!editorContainerRef.current) return;

		const contentHeight = editorInstance.getContentHeight();
		const width = editorContainerRef.current.clientWidth || 300;

		if (expanded) {
			if (editorContainerRef.current) {
				editorContainerRef.current.style.height = `${contentHeight}px`;
			}
			editorInstance.layout({ width, height: contentHeight });
		} else {
			const newContentHeight = Math.min(contentHeight, collapsedHeight);
			if (editorContainerRef.current) {
				editorContainerRef.current.style.height = `${newContentHeight}px`;
			}
			// Always lay the editor out for the full height
			editorInstance.layout({ width, height: contentHeight });
		}
	};

	const toggleExpanded = () => {
		setExpanded(!expanded);
	};

	const toggleOpen = () => {
		setOpen(!open);
	};

	// Check if content exceeds collapsed height and should show expand button
	const hasExpandableContent = editor ? editor.getContentHeight() > collapsedHeight : false;

	return (
		<div className={`codeview-wrapper ${!expanded && hasExpandableContent ? 'collapsed' : ''}`}>
			<details className="codeview-details" open={open}>
				<summary
					className="codeview-header"
					tabIndex={0}
					onClick={(e) => {
						// This is needed to prevent the default details toggle behavior
						// so we can handle it ourselves
						e.preventDefault();
						toggleOpen();
					}}
				>
					<span className="icon codeview-toggle"
						aria-label="Toggle code section"
						title={open ? 'Hide code' : 'Show code'}
					><i className={'codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></i></span>

					<span className="codeview-title">{label}</span>
					{description && <span className="codeview-description">{description}</span>}
				</summary>

				<div
					className="codeview-content"
					style={{ display: open ? 'block' : 'none' }}
					ref={contentRef}
				>
					<div
						className="codeview-editor-container"
						ref={editorContainerRef}
					/>

					{hasExpandableContent && (
						<button
							type="button"
							className="codeview-expand"
							onClick={toggleExpanded}
							style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5em' }}
						>
							<span className="icon"><i className={'codicon ' + (expanded ? 'codicon-fold' : 'codicon-unfold')}></i></span>
							{expanded ? 'Show less' : 'Show more'}
						</button>
					)}
				</div>
			</details>
		</div>
	);
};

