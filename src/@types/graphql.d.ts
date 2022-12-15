/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module '*.gql' {
	import { DocumentNode } from 'graphql';
	const value: DocumentNode;
	export default value;
}