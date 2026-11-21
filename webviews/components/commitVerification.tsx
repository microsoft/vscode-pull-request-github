/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';
import { checkIcon, errorIcon } from './icon';
import { Avatar } from './user';
import { CommitEvent } from '../../src/common/timelineEvent';

function commitVerificationMessage(verification: NonNullable<CommitEvent['verification']>): string {
	if (verification.verified) {
		if (verification.wasSignedByGitHub) {
			return 'This commit was created on GitHub.com and signed with GitHub\u2019s verified signature.';
		}
		return 'This commit was signed with the committer\u2019s verified signature.';
	}
	return 'This commit is signed, but the signature could not be verified.';
}

export function CommitVerificationBadge({ verification, committedDate }: { verification: CommitEvent['verification']; committedDate: Date; }) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onDocumentClick = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', onDocumentClick);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onDocumentClick);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	if (!verification || verification.state === 'UNSIGNED') {
		return null;
	}

	const verified = verification.verified;
	const label = verified ? 'Verified' : 'Unverified';
	const signer = verification.signer;
	const keyLabel = verification.keyId
		? { name: 'GPG key ID', value: verification.keyId }
		: (verification.keyFingerprint
			? { name: 'SSH key fingerprint', value: verification.keyFingerprint }
			: undefined);

	return (
		<span className="verified-pill-container" ref={containerRef}>
			<span
				className={`verified-pill ${verified ? 'verified' : 'unverified'}`}
				role="button"
				tabIndex={0}
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				onKeyDown={e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						setOpen(value => !value);
					}
				}}
			>
				{label}
			</span>
			{open && (
				<div className="verified-popover" role="tooltip">
					<div className="verified-popover-header">
						<span className={`verified-popover-icon ${verified ? 'verified' : 'unverified'}`}>
							{verified ? checkIcon : errorIcon}
						</span>
						<span className="verified-popover-message">
							{commitVerificationMessage(verification)}
						</span>
					</div>
					{signer && (
						<div className="verified-popover-signer">
							<div className="avatar-container">
								<Avatar for={{ login: signer.login, avatarUrl: signer.avatarUrl, url: `https://github.com/${signer.login}` }} />
							</div>
							<div className="verified-popover-signer-names">
								<span className="verified-popover-signer-login">{signer.login}</span>
								{signer.name && <span className="verified-popover-signer-name">{signer.name}</span>}
							</div>
						</div>
					)}
					{keyLabel && (
						<div className="verified-popover-detail">
							{keyLabel.name}: {keyLabel.value}
						</div>
					)}
					{verified && (
						<div className="verified-popover-detail">
							Verified on {new Date(committedDate).toLocaleString(undefined, {
								year: 'numeric', month: 'short', day: 'numeric',
								hour: 'numeric', minute: '2-digit',
							})}
						</div>
					)}
				</div>
			)}
		</span>
	);
}
