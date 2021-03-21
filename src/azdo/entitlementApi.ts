/*
* ---------------------------------------------------------
* Copyright(C) Microsoft Corporation. All rights reserved.
* ---------------------------------------------------------
*/

// Licensed under the MIT license.  See LICENSE file in the project root for full license information.

import * as restm from 'typed-rest-client/RestClient';
import * as basem from 'azure-devops-node-api/ClientApiBases'
import * as vsom from 'azure-devops-node-api/VsoClient'
import * as VsoBaseInterfaces from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces'
import * as IdentitiesInterfaces from 'azure-devops-node-api/interfaces/IdentitiesInterfaces'
import { WebApi } from 'azure-devops-node-api';

export interface UserEntitlementSearchResult {
    members: IdentitiesInterfaces.Identity[];
    continuationToken?: string;
    totalCount: number;
    items: IdentitiesInterfaces.Identity[];
}

export interface IUserEntitlementApi extends basem.ClientApiBase {
    searchUserEntitlement(filterValue?: string): Promise<UserEntitlementSearchResult>;
}

export class UserEntitlementApi extends basem.ClientApiBase implements IUserEntitlementApi {
    constructor(baseUrl: string, handlers: VsoBaseInterfaces.IRequestHandler[], options?: VsoBaseInterfaces.IRequestOptions) {
        super(baseUrl, handlers, 'node-Identities-api', options);
    }

    public async searchUserEntitlement(
        filterValue?: string,
    ): Promise<UserEntitlementSearchResult> {

        return new Promise<UserEntitlementSearchResult>(async (resolve, reject) => {
            let routeValues: any = {
            };

            let queryValues: any = {
                $filter: filterValue,
            };

            try {
                let verData: vsom.ClientVersioningData = await this.vsoClient.getVersioningData(
                    "6.1-preview.3",
                    "MemberEntitlementManagement",
                    "8480c6eb-ce60-47e9-88df-eca3c801638b",
                    routeValues,
                    queryValues);

                let url: string = verData.requestUrl ?? '';
                let options: restm.IRequestOptions = this.createRequestOptions('application/json',
                    verData.apiVersion);
                let res: restm.IRestResponse<UserEntitlementSearchResult>;
                res = await this.rest.get<UserEntitlementSearchResult>(url, options);

                let ret = this.formatResponse(res.result,
                    null,
                    true);

                resolve(ret);

            }
            catch (err) {
                reject(err);
            }
        });
    }
}

export const getIdentitiesApi = async (webApi: WebApi, serverUrl?: string, handlers?: VsoBaseInterfaces.IRequestHandler[]): Promise<IUserEntitlementApi> => {
	// TODO: Load RESOURCE_AREA_ID correctly.
	serverUrl = await (webApi as any)._getResourceAreaUrl(serverUrl || webApi.serverUrl, "68ddce18-2501-45f1-a17b-7931a9922690");
	handlers = handlers || [webApi.authHandler];
	return new UserEntitlementApi(serverUrl!, handlers, webApi.options);
}