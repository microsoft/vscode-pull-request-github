/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { ComplexityService, ComplexityScore } from '../../issues/complexityService';
import { IssueModel } from '../../github/issueModel';

describe('ComplexityService', () => {
	let complexityService: ComplexityService;

	beforeEach(() => {
		complexityService = new ComplexityService();
	});

	afterEach(() => {
		complexityService.clearCache();
	});

	describe('extractSearchQueries', () => {
		it('should extract function names from issue body', () => {
			const mockIssue = {
				title: 'Fix calculateComplexity function',
				body: 'The `calculateComplexity()` function is not working properly in the ComplexityService class.',
				number: 123,
				updatedAt: '2023-01-01'
			} as IssueModel;

			// Access the private method through type assertion for testing
			const service = complexityService as any;
			const queries = service.extractSearchQueries(mockIssue);

			assert(queries.includes('Fix calculateComplexity function'), 'Should include title');
			assert(queries.some((q: string) => q.includes('calculateComplexity')), 'Should extract function name');
		});

		it('should extract file references from issue body', () => {
			const mockIssue = {
				title: 'Update dashboard.tsx file',
				body: 'Need to modify dashboard.tsx and utils.ts files',
				number: 123,
				updatedAt: '2023-01-01'
			} as IssueModel;

			const service = complexityService as any;
			const queries = service.extractSearchQueries(mockIssue);

			assert(queries.length > 0, 'Should extract queries');
			assert(queries.includes('Update dashboard.tsx file'), 'Should include title');
		});

		it('should handle empty issue body', () => {
			const mockIssue = {
				title: 'Simple issue',
				body: '',
				number: 123,
				updatedAt: '2023-01-01'
			} as IssueModel;

			const service = complexityService as any;
			const queries = service.extractSearchQueries(mockIssue);

			assert.strictEqual(queries[0], 'Simple issue', 'Should at least include title');
		});

		it('should limit queries to maximum of 3', () => {
			const mockIssue = {
				title: 'Complex issue with many functions',
				body: 'Fix `functionA()`, `functionB()`, `functionC()`, `functionD()`, `functionE()` and more',
				number: 123,
				updatedAt: '2023-01-01'
			} as IssueModel;

			const service = complexityService as any;
			const queries = service.extractSearchQueries(mockIssue);

			assert(queries.length <= 3, 'Should limit to 3 queries');
		});
	});

	describe('getCachedComplexity', () => {
		it('should return undefined for non-cached issues', () => {
			const mockIssue = {
				number: 123,
				updatedAt: '2023-01-01'
			} as IssueModel;

			const result = complexityService.getCachedComplexity(mockIssue);
			assert.strictEqual(result, undefined);
		});
	});

	describe('clearCache', () => {
		it('should clear the cache', () => {
			// This test verifies that clearCache works without throwing
			assert.doesNotThrow(() => {
				complexityService.clearCache();
			});
		});
	});

	describe('parseComplexityResponse', () => {
		it('should parse valid JSON response', () => {
			const service = complexityService as any;
			const response = '{"score": 75, "reasoning": "Complex feature"}';
			const result: ComplexityScore = service.parseComplexityResponse(response);

			assert.strictEqual(result.score, 75);
			assert.strictEqual(result.reasoning, 'Complex feature');
		});

		it('should parse JSON with extra text', () => {
			const service = complexityService as any;
			const response = 'Here is the analysis: {"score": 45, "reasoning": "Medium complexity"} with more text';
			const result: ComplexityScore = service.parseComplexityResponse(response);

			assert.strictEqual(result.score, 45);
			assert.strictEqual(result.reasoning, 'Medium complexity');
		});

		it('should fallback to number extraction', () => {
			const service = complexityService as any;
			const response = 'The complexity score is 85 out of 100';
			const result: ComplexityScore = service.parseComplexityResponse(response);

			assert.strictEqual(result.score, 85);
		});

		it('should return default score for invalid response', () => {
			const service = complexityService as any;
			const response = 'Invalid response without numbers';
			const result: ComplexityScore = service.parseComplexityResponse(response);

			assert.strictEqual(result.score, 50);
		});

		it('should handle scores outside valid range', () => {
			const service = complexityService as any;
			const response = '{"score": 150, "reasoning": "Invalid score"}';
			const result: ComplexityScore = service.parseComplexityResponse(response);

			assert.strictEqual(result.score, 50); // Should fallback to default
		});
	});
});