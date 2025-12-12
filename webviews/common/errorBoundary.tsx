/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

export class ErrorBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(_error) {
		return { hasError: true };
	}

	override componentDidCatch(error, errorInfo) {
		console.log(error);
		console.log(errorInfo);
	}

	override render() {
		if ((this.state as any).hasError) {
			return <div>Something went wrong.</div>;
		}

		return this.props.children ?? null;
	}
}