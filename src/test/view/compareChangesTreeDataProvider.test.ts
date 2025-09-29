/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';

// Test the text truncation logic that should be applied to tree view button text
describe('CompareChangesTreeDataProvider text truncation', () => {
	const MAX_BUTTON_TEXT_LENGTH = 40; // Same constant used in implementation
	
	function truncateButtonText(buttonText: string): string {
		return buttonText.length > MAX_BUTTON_TEXT_LENGTH 
			? buttonText.substring(0, MAX_BUTTON_TEXT_LENGTH - 3) + '...'
			: buttonText;
	}

	describe('button text truncation', () => {
		it('should truncate long button text with ellipsis', () => {
			const longButtonText = '$(sparkle) Very Long Copilot Reviewer Name That Would Cause Overflow Issues Code Review';
			const result = truncateButtonText(longButtonText);
			
			assert.strictEqual(result.length, MAX_BUTTON_TEXT_LENGTH);
			assert.ok(result.endsWith('...'));
			assert.ok(result.includes('$(sparkle)'));
			assert.ok(!result.includes('Overflow Issues Code Review'));
		});

		it('should not truncate short button text', () => {
			const shortButtonText = '$(sparkle) Copilot Code Review';
			const result = truncateButtonText(shortButtonText);
			
			assert.strictEqual(result, shortButtonText);
			assert.ok(!result.includes('...'));
		});

		it('should handle exactly max length text', () => {
			const exactLengthText = 'A'.repeat(MAX_BUTTON_TEXT_LENGTH);
			const result = truncateButtonText(exactLengthText);
			
			assert.strictEqual(result, exactLengthText);
			assert.ok(!result.includes('...'));
		});

		it('should handle text that is one character over the limit', () => {
			const overLimitByOne = 'A'.repeat(MAX_BUTTON_TEXT_LENGTH + 1);
			const result = truncateButtonText(overLimitByOne);
			
			assert.strictEqual(result.length, MAX_BUTTON_TEXT_LENGTH);
			assert.ok(result.endsWith('...'));
			assert.strictEqual(result, 'A'.repeat(MAX_BUTTON_TEXT_LENGTH - 3) + '...');
		});

		it('should preserve sparkle icon in truncated text', () => {
			const longTextWithIcon = '$(sparkle) ' + 'Very '.repeat(20) + 'Long Code Review';
			const result = truncateButtonText(longTextWithIcon);
			
			assert.ok(result.startsWith('$(sparkle)'));
			assert.ok(result.endsWith('...'));
			assert.strictEqual(result.length, MAX_BUTTON_TEXT_LENGTH);
		});
	});
});