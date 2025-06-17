/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { COPILOT_LOGINS } from '../../common/copilot';
import { OctokitCommon } from '../../github/common';
import { IssueModel } from '../../github/issueModel';
import { RepositoriesManager } from '../../github/repositoriesManager';

export interface copilotRemoteAgentToolParameters {
    repo?: {
        owner?: string;
        name?: string;
    };
    title: string;
    body?: string;
}

export class copilotRemoteAgentTool
    implements vscode.LanguageModelTool<copilotRemoteAgentToolParameters> {
    public static readonly toolId = 'github-pull-request_copilot-remote-agent';
    private repositoriesManager: RepositoriesManager;

    constructor(repositoriesManager: RepositoriesManager) {
        this.repositoriesManager = repositoriesManager;
    }

    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: vscode.l10n.t(
                'Creating an issue and assigning Copilot'
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<copilotRemoteAgentToolParameters>,
        _: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult | undefined> {
        const repo = options.input.repo;
        const owner = repo?.owner;
        const name = repo?.name;
        const title = options.input.title;
        const body = options.input.body || '';
        if (!repo || !owner || !name || !title) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Missing required repo, owner, name, or title.'
                ),
            ]);
        }
        // Find the folder manager for the repo
        let folderManager = this.repositoriesManager.getManagerForRepository(
            owner,
            name
        );
        if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
            folderManager = this.repositoriesManager.folderManagers[0];
        }
        if (!folderManager) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No folder manager found for ${owner}/${name}. Make sure to have the repository open.`
                ),
            ]);
        }

        // Create the issue using OctokitCommon.IssuesCreateParams
        const params: OctokitCommon.IssuesCreateParams = {
            owner,
            repo: name,
            title,
            body,
        };
        let createdIssue: IssueModel | undefined;
        try {
            createdIssue = await folderManager.createIssue(params);
        } catch (e) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Failed to create issue for ${owner}/${name}: ${e}`
                ),
            ]);
        }
        if (!createdIssue) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Failed to create issue for ${owner}/${name}.`
                ),
            ]);
        }

        // Assign Copilot (swe-agent) to the issue using assignable user object and replaceAssignees
        try {
            // Get assignable users for all remotes (returns a map of remoteName to IAccount[])
            const assignableUsersMap = await folderManager.getAssignableUsers();
            // Find the correct array for the current repo remote
            let assignableUsers: any[] | undefined = undefined;
            if (
                createdIssue &&
                createdIssue.remote &&
                createdIssue.remote.remoteName &&
                assignableUsersMap[createdIssue.remote.remoteName]
            ) {
                assignableUsers = assignableUsersMap[createdIssue.remote.remoteName];
            } else {
                // fallback: try any array in the map
                assignableUsers = Object.values(assignableUsersMap)[0];
            }
            if (!assignableUsers) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Issue created, but no assignable users found for ${owner}/${name}.`
                    ),
                ]);
            }
            // Find the Copilot user object (by login)
            const copilotUser = assignableUsers.find((user: any) =>
                COPILOT_LOGINS.includes(user.login)
            );
            if (!copilotUser) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Issue created, but Copilot user was not found in assignable users for ${owner}/${name}.`
                    ),
                ]);
            }
            // Use replaceAssignees to assign Copilot
            await createdIssue.replaceAssignees([copilotUser]);
        } catch (e) {
            // If replaceAssignees fails, return error but still return the created issue
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Issue created, but failed to assign Copilot: ${e}`
                ),
            ]);
        }

        const issueInfo = {
            number: createdIssue.number,
            title: createdIssue.title,
            body: createdIssue.body,
            assignees: createdIssue.assignees,
            url: createdIssue.html_url,
            state: createdIssue.state,
        };
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(issueInfo)),
        ]);
    }
}
