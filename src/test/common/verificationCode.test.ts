/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VerificationCodeManager } from '../../common/utils';

suite('VerificationCodeManager Tests', () => {
	test('should generate verification code with default options', () => {
		const code = VerificationCodeManager.generateVerificationCode();
		
		assert.strictEqual(code.code.length, 6);
		assert.strictEqual(code.attempts, 0);
		assert.strictEqual(code.maxAttempts, 3);
		assert.ok(code.expiresAt > new Date());
		assert.ok(code.createdAt <= new Date());
	});

	test('should generate verification code with custom options', () => {
		const options = {
			expirationMinutes: 5,
			maxAttempts: 5,
			codeLength: 8
		};
		const code = VerificationCodeManager.generateVerificationCode(options);
		
		assert.strictEqual(code.code.length, 8);
		assert.strictEqual(code.maxAttempts, 5);
		
		// Check expiration is approximately 5 minutes
		const expectedExpiration = new Date(Date.now() + 5 * 60 * 1000);
		const timeDiff = Math.abs(code.expiresAt.getTime() - expectedExpiration.getTime());
		assert.ok(timeDiff < 1000); // Within 1 second tolerance
	});

	test('should correctly identify expired codes', () => {
		const code = VerificationCodeManager.generateVerificationCode({ expirationMinutes: 0 });
		
		// Wait a small amount to ensure expiration
		setTimeout(() => {
			assert.ok(VerificationCodeManager.isExpired(code));
		}, 10);
	});

	test('should correctly identify non-expired codes', () => {
		const code = VerificationCodeManager.generateVerificationCode({ expirationMinutes: 10 });
		assert.ok(!VerificationCodeManager.isExpired(code));
	});

	test('should validate correct verification code', () => {
		const code = VerificationCodeManager.generateVerificationCode();
		const result = VerificationCodeManager.validateCode(code, code.code);
		
		assert.ok(result.isValid);
		assert.ok(!result.canRetry); // Valid code, no retry needed
		assert.strictEqual(code.attempts, 1);
	});

	test('should handle incorrect verification code with retries', () => {
		const code = VerificationCodeManager.generateVerificationCode({ maxAttempts: 3 });
		
		// First attempt - incorrect
		let result = VerificationCodeManager.validateCode(code, 'wrong');
		assert.ok(!result.isValid);
		assert.ok(result.canRetry);
		assert.strictEqual(code.attempts, 1);
		
		// Second attempt - incorrect
		result = VerificationCodeManager.validateCode(code, 'wrong');
		assert.ok(!result.isValid);
		assert.ok(result.canRetry);
		assert.strictEqual(code.attempts, 2);
		
		// Third attempt - incorrect, max attempts reached
		result = VerificationCodeManager.validateCode(code, 'wrong');
		assert.ok(!result.isValid);
		assert.ok(!result.canRetry);
		assert.strictEqual(code.attempts, 3);
	});

	test('should prevent validation of expired codes', () => {
		const expiredCode = VerificationCodeManager.generateVerificationCode({ expirationMinutes: 0 });
		
		setTimeout(() => {
			const result = VerificationCodeManager.validateCode(expiredCode, expiredCode.code);
			assert.ok(!result.isValid);
			assert.ok(!result.canRetry);
		}, 10);
	});

	test('should calculate remaining time correctly', () => {
		const code = VerificationCodeManager.generateVerificationCode({ expirationMinutes: 5 });
		const remainingTime = VerificationCodeManager.getRemainingTime(code);
		
		assert.ok(remainingTime >= 4 && remainingTime <= 5);
	});

	test('should return zero remaining time for expired codes', () => {
		const expiredCode = VerificationCodeManager.generateVerificationCode({ expirationMinutes: 0 });
		
		setTimeout(() => {
			const remainingTime = VerificationCodeManager.getRemainingTime(expiredCode);
			assert.strictEqual(remainingTime, 0);
		}, 10);
	});

	test('should handle maximum attempts correctly', () => {
		const code = VerificationCodeManager.generateVerificationCode({ maxAttempts: 1 });
		
		assert.ok(!VerificationCodeManager.hasExceededAttempts(code));
		
		// Make one attempt
		VerificationCodeManager.validateCode(code, 'wrong');
		assert.ok(VerificationCodeManager.hasExceededAttempts(code));
	});

	test('should generate numeric codes only', () => {
		const code = VerificationCodeManager.generateVerificationCode({ codeLength: 10 });
		const isNumeric = /^\d+$/.test(code.code);
		assert.ok(isNumeric, 'Generated code should contain only digits');
	});
});