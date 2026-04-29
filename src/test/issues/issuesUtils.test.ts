/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { getIssueOrURLExpression, ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput } from '../../github/utils';

describe('Issues utilities', function () {
	it('regular expressions', async function () {
		const issueNumber = '#1234';
		const issueNumberParsed = parseIssueExpressionOutput(issueNumber.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(issueNumberParsed?.issueNumber, 1234);
		assert.strictEqual(issueNumberParsed?.commentNumber, undefined);
		assert.strictEqual(issueNumberParsed?.name, undefined);
		assert.strictEqual(issueNumberParsed?.owner, undefined);

		const issueNumberGH = 'GH-321';
		const issueNumberGHParsed = parseIssueExpressionOutput(issueNumberGH.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(issueNumberGHParsed?.issueNumber, 321);
		assert.strictEqual(issueNumberGHParsed?.commentNumber, undefined);
		assert.strictEqual(issueNumberGHParsed?.name, undefined);
		assert.strictEqual(issueNumberGHParsed?.owner, undefined);
		const issueSingleDigit = '#1';
		const issueSingleDigitParsed = parseIssueExpressionOutput(issueSingleDigit.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(issueSingleDigitParsed?.issueNumber, 1);
		assert.strictEqual(issueSingleDigitParsed?.commentNumber, undefined);
		assert.strictEqual(issueSingleDigitParsed?.name, undefined);
		assert.strictEqual(issueSingleDigitParsed?.owner, undefined);
		const issueRepo = 'alexr00/myRepo#234';
		const issueRepoParsed = parseIssueExpressionOutput(issueRepo.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(issueRepoParsed?.issueNumber, 234);
		assert.strictEqual(issueRepoParsed?.commentNumber, undefined);
		assert.strictEqual(issueRepoParsed?.name, 'myRepo');
		assert.strictEqual(issueRepoParsed?.owner, 'alexr00');
		const issueUrl = 'http://github.com/alexr00/myRepo/issues/567';
		const issueUrlParsed = parseIssueExpressionOutput(issueUrl.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(issueUrlParsed?.issueNumber, 567);
		assert.strictEqual(issueUrlParsed?.commentNumber, undefined);
		assert.strictEqual(issueUrlParsed?.name, 'myRepo');
		assert.strictEqual(issueUrlParsed?.owner, 'alexr00');
		const commentUrl = 'https://github.com/microsoft/vscode/issues/96#issuecomment-641150523';
		const commentUrlParsed = parseIssueExpressionOutput(commentUrl.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(commentUrlParsed?.issueNumber, 96);
		assert.strictEqual(commentUrlParsed?.commentNumber, 641150523);
		assert.strictEqual(commentUrlParsed?.name, 'vscode');
		assert.strictEqual(commentUrlParsed?.owner, 'microsoft');
		const notIssue = '#a4';
		const notIssueParsed = parseIssueExpressionOutput(notIssue.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(notIssueParsed, undefined);

		// Test PR URL parsing
		const prUrl = 'https://github.com/microsoft/vscode/pull/123';
		const prUrlParsed = parseIssueExpressionOutput(prUrl.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(prUrlParsed?.issueNumber, 123);
		assert.strictEqual(prUrlParsed?.commentNumber, undefined);
		assert.strictEqual(prUrlParsed?.name, 'vscode');
		assert.strictEqual(prUrlParsed?.owner, 'microsoft');

		// Test HTTP PR URL (without S)
		const prUrlHttp = 'http://github.com/owner/repo/pull/456';
		const prUrlHttpParsed = parseIssueExpressionOutput(prUrlHttp.match(ISSUE_OR_URL_EXPRESSION));
		assert.strictEqual(prUrlHttpParsed?.issueNumber, 456);
		assert.strictEqual(prUrlHttpParsed?.commentNumber, undefined);
		assert.strictEqual(prUrlHttpParsed?.name, 'repo');
		assert.strictEqual(prUrlHttpParsed?.owner, 'owner');
	});

	it('getIssueOrURLExpression matches enterprise host URLs', function () {
		const enterpriseExpression = getIssueOrURLExpression(vscode.Uri.parse('https://my.ghe.host'));

		// Enterprise host URL is matched
		const enterpriseIssueUrl = 'https://my.ghe.host/org/repo/issues/123';
		const enterpriseIssueParsed = parseIssueExpressionOutput(enterpriseIssueUrl.match(enterpriseExpression));
		assert.strictEqual(enterpriseIssueParsed?.issueNumber, 123);
		assert.strictEqual(enterpriseIssueParsed?.commentNumber, undefined);
		assert.strictEqual(enterpriseIssueParsed?.name, 'repo');
		assert.strictEqual(enterpriseIssueParsed?.owner, 'org');

		// Enterprise PR URL is matched
		const enterprisePrUrl = 'https://my.ghe.host/org/repo/pull/456';
		const enterprisePrParsed = parseIssueExpressionOutput(enterprisePrUrl.match(enterpriseExpression));
		assert.strictEqual(enterprisePrParsed?.issueNumber, 456);
		assert.strictEqual(enterprisePrParsed?.name, 'repo');
		assert.strictEqual(enterprisePrParsed?.owner, 'org');

		// Enterprise comment URL is matched
		const enterpriseCommentUrl = 'https://my.ghe.host/org/repo/issues/789#issuecomment-12345';
		const enterpriseCommentParsed = parseIssueExpressionOutput(enterpriseCommentUrl.match(enterpriseExpression));
		assert.strictEqual(enterpriseCommentParsed?.issueNumber, 789);
		assert.strictEqual(enterpriseCommentParsed?.commentNumber, 12345);
		assert.strictEqual(enterpriseCommentParsed?.name, 'repo');
		assert.strictEqual(enterpriseCommentParsed?.owner, 'org');

		// github.com URLs are still matched when an enterprise URI is provided
		const dotComUrl = 'https://github.com/microsoft/vscode/issues/96';
		const dotComParsed = parseIssueExpressionOutput(dotComUrl.match(enterpriseExpression));
		assert.strictEqual(dotComParsed?.issueNumber, 96);
		assert.strictEqual(dotComParsed?.name, 'vscode');
		assert.strictEqual(dotComParsed?.owner, 'microsoft');

		// Without an enterprise URI, only github.com URLs are matched as full URLs
		const defaultExpression = getIssueOrURLExpression();
		const enterpriseAgainstDefault = parseIssueExpressionOutput(enterpriseIssueUrl.match(defaultExpression));
		// The owner/repo/number should not match the URL form (the alternate `owner/repo#num` form is also not present here).
		assert.strictEqual(enterpriseAgainstDefault, undefined);
	});
});
