import * as restm from 'typed-rest-client/RestClient';
import * as basem from 'azure-devops-node-api/ClientApiBases';
import * as vsom from 'azure-devops-node-api/VsoClient';
import * as VsoBaseInterfaces from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import { WebApi } from 'azure-devops-node-api';

export interface User {
	id: string;
	user: {
		subjectKind: string;
		metaType: string;
		directoryAlias: string;
		domain: string;
		principalName: string;
		mailAddress: string;
		origin: string;
		originId: string;
		displayName: string;
		_links: any;
		url: string;
		descriptor: string;
	};
	accessLevel: {
		licensingSource: string;
		accountLicenseType: string;
		msdnLicenseType: string;
		licenseDisplayName: string;
		status: string;
		statusMessage: string;
		assignmentSource: string;
	};
	lastAccessedDate: Date;
	dateCreated: Date;
	projectEntitlements: any[];
	extensions: any[];
	groupAssignments: any[];
}

export interface UserEntitlementSearchResult {
	members: User[];
	continuationToken?: string;
	totalCount: number;
	items: User[];
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
			const routeValues: any = {
			};

			const queryValues: any = {
				$filter: filterValue,
			};

			try {
				const verData: vsom.ClientVersioningData = await this.vsoClient.getVersioningData(
					'6.1-preview.3',
					'MemberEntitlementManagement',
					'8480c6eb-ce60-47e9-88df-eca3c801638b',
					routeValues,
					queryValues);

				const url: string = verData.requestUrl ?? '';
				const options: restm.IRequestOptions = this.createRequestOptions('application/json',
					verData.apiVersion);
				const res = await this.rest.get<UserEntitlementSearchResult>(url, options);

				const ret = this.formatResponse(res.result,
					null,
					true);

				resolve(ret);

			} catch (err) {
				reject(err);
			}
		});
	}
}

export const getEntitlementApi = async (webApi: WebApi, serverUrl?: string, handlers?: VsoBaseInterfaces.IRequestHandler[]): Promise<IUserEntitlementApi | undefined> => {
	// TODO: Load RESOURCE_AREA_ID correctly.
	if (!webApi) {
		return undefined;
	}
	serverUrl = await (webApi as any)._getResourceAreaUrl(serverUrl || webApi.serverUrl, '68ddce18-2501-45f1-a17b-7931a9922690');
	handlers = handlers || [webApi.authHandler];
	return new UserEntitlementApi(serverUrl!, handlers, webApi.options);
};