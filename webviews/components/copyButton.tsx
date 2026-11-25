/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { checkIcon, copyIcon, errorIcon } from './icon';
import { useBusyAction, useMountedRef } from '../common/hooks';

/** How long the button shows whether it copied. */
const COPY_FEEDBACK_MS = 2000;

/** An icon button that copies something and then shows whether it was copied. */
export function CopyButton({ title, ariaLabel, className, copy }: { title: string; ariaLabel?: string; className?: string; copy: () => Promise<unknown> }) {
	const [isCopying, run] = useBusyAction();
	const [result, setResult] = useState<'copied' | 'failed' | undefined>();
	const mounted = useMountedRef();

	useEffect(() => {
		if (!result) {
			return;
		}
		const timer = setTimeout(() => setResult(undefined), COPY_FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [result]);

	const onClick = async () => {
		setResult(undefined);
		let copied: boolean;
		try {
			await run(copy);
			copied = true;
		} catch {
			// Nothing else tells the user, since a failed copy just leaves the clipboard as it was.
			copied = false;
		}
		if (mounted.current) {
			setResult(copied ? 'copied' : 'failed');
		}
	};

	const label = isCopying ? 'Copying...' : result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : undefined;
	return (
		<button
			title={label ?? title}
			aria-label={label ?? ariaLabel ?? title}
			className={className ? `icon-button ${className}` : 'icon-button'}
			disabled={isCopying}
			onClick={onClick}
		>
			{result === 'copied' ? checkIcon : result === 'failed' ? errorIcon : copyIcon}
		</button>
	);
}
