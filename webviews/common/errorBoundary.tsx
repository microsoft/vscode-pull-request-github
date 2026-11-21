/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface ErrorBoundaryProps {
	children?: React.ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(_error: unknown): ErrorBoundaryState {
		return { hasError: true };
	}

	override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
		console.error(error);
		console.error(errorInfo);
	}

	override render(): React.ReactNode {
		if (this.state.hasError) {
			return <div>Something went wrong.</div>;
		}

		return this.props.children ?? null;
	}
}