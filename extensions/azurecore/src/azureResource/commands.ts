/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { window, QuickPickItem } from 'vscode';
import * as azdata from 'azdata';
import { TokenCredentials } from '@azure/ms-rest-js';
import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import { AppContext } from '../appContext';
import { azureResource } from './azure-resource';
import { TreeNode } from './treeNode';
import { AzureResourceCredentialError } from './errors';
import { AzureResourceTreeProvider } from './tree/treeProvider';
import { AzureResourceAccountTreeNode } from './tree/accountTreeNode';
import { IAzureResourceSubscriptionService, IAzureResourceSubscriptionFilterService } from '../azureResource/interfaces';
import { AzureResourceServiceNames } from './constants';
import { AzureResourceGroupService } from './providers/resourceGroup/resourceGroupService';
import { GetSubscriptionsResult, GetResourceGroupsResult } from '../azurecore';
import { isArray } from 'util';

export function registerAzureResourceCommands(appContext: AppContext, tree: AzureResourceTreeProvider): void {

	// Resource Management commands
	appContext.apiWrapper.registerCommand('azure.accounts.getSubscriptions', async (account?: azdata.Account, ignoreErrors: boolean = false): Promise<GetSubscriptionsResult> => {
		const result: GetSubscriptionsResult = { subscriptions: [], errors: [] };
		if (!account?.properties?.tenants || !isArray(account.properties.tenants)) {
			const error = new Error('Invalid account');
			if (!ignoreErrors) {
				throw error;
			}
			result.errors.push(error);
			return result;
		}
		const subscriptionService = appContext.getService<IAzureResourceSubscriptionService>(AzureResourceServiceNames.subscriptionService);
		const tokens = await appContext.apiWrapper.getSecurityToken(account, azdata.AzureResource.ResourceManagement);
		await Promise.all(account.properties.tenants.map(async (tenant: { id: string | number; }) => {
			try {
				const token = tokens[tenant.id].token;
				const tokenType = tokens[tenant.id].tokenType;

				result.subscriptions.push(...await subscriptionService.getSubscriptions(account, new TokenCredentials(token, tokenType)));
			} catch (err) {
				console.warn(`Error fetching subscriptions for account ${account.displayInfo.displayName} tenant ${tenant.id} : ${err}`);
				if (!ignoreErrors) {
					throw err;
				}
				result.errors.push(err);
			}
			return Promise.resolve();
		}));
		return result;
	});

	appContext.apiWrapper.registerCommand('azure.accounts.getResourceGroups', async (account?: azdata.Account, subscription?: azureResource.AzureResourceSubscription, ignoreErrors: boolean = false): Promise<GetResourceGroupsResult> => {
		const result: GetResourceGroupsResult = { resourceGroups: [], errors: [] };
		if (!account?.properties?.tenants || !isArray(account.properties.tenants) || !subscription) {
			const error = new Error('Invalid account or subscription');
			if (!ignoreErrors) {
				throw error;
			}
			result.errors.push(error);
			return result;
		}
		const service = new AzureResourceGroupService();
		await Promise.all(account.properties.tenants.map(async (tenant: { id: string | number; }) => {
			try {
				const tokens = await appContext.apiWrapper.getSecurityToken(account, azdata.AzureResource.ResourceManagement);
				const token = tokens[tenant.id].token;
				const tokenType = tokens[tenant.id].tokenType;

				result.resourceGroups.push(...await service.getResources(subscription, new TokenCredentials(token, tokenType)));
			} catch (err) {
				console.warn(`Error fetching resource groups for account ${account.displayInfo.displayName} (${account.displayInfo.userId}) subscription ${subscription.id} (${subscription.name}) tenant ${tenant.id} : ${err}`);
				if (!ignoreErrors) {
					throw err;
				}
				result.errors.push(err);
			}
			return Promise.resolve();
		}));

		return result;
	});

	// Resource Tree commands
	appContext.apiWrapper.registerCommand('azure.resource.selectsubscriptions', async (node?: TreeNode) => {
		if (!(node instanceof AzureResourceAccountTreeNode)) {
			return;
		}

		const subscriptionService = appContext.getService<IAzureResourceSubscriptionService>(AzureResourceServiceNames.subscriptionService);
		const subscriptionFilterService = appContext.getService<IAzureResourceSubscriptionFilterService>(AzureResourceServiceNames.subscriptionFilterService);

		const accountNode = node as AzureResourceAccountTreeNode;

		const subscriptions = (await accountNode.getCachedSubscriptions()) || <azureResource.AzureResourceSubscription[]>[];
		if (subscriptions.length === 0) {
			try {
				const tokens = await this.servicePool.apiWrapper.getSecurityToken(this.account, azdata.AzureResource.ResourceManagement);

				for (const tenant of this.account.properties.tenants) {
					const token = tokens[tenant.id].token;
					const tokenType = tokens[tenant.id].tokenType;

					subscriptions.push(...await subscriptionService.getSubscriptions(accountNode.account, new TokenCredentials(token, tokenType)));
				}
			} catch (error) {
				throw new AzureResourceCredentialError(localize('azure.resource.selectsubscriptions.credentialError', "Failed to get credential for account {0}. Please refresh the account.", this.account.key.accountId), error);
			}
		}

		let selectedSubscriptions = await subscriptionFilterService.getSelectedSubscriptions(accountNode.account);
		if (!selectedSubscriptions) {
			selectedSubscriptions = [];
		}

		const selectedSubscriptionIds: string[] = [];
		if (selectedSubscriptions.length > 0) {
			selectedSubscriptionIds.push(...selectedSubscriptions.map((subscription) => subscription.id));
		} else {
			// ALL subscriptions are selected by default
			selectedSubscriptionIds.push(...subscriptions.map((subscription) => subscription.id));
		}

		interface AzureResourceSubscriptionQuickPickItem extends QuickPickItem {
			subscription: azureResource.AzureResourceSubscription;
		}

		const subscriptionQuickPickItems: AzureResourceSubscriptionQuickPickItem[] = subscriptions.map((subscription) => {
			return {
				label: subscription.name,
				picked: selectedSubscriptionIds.indexOf(subscription.id) !== -1,
				subscription: subscription
			};
		}).sort((a, b) => a.label.localeCompare(b.label));

		const selectedSubscriptionQuickPickItems = await window.showQuickPick(subscriptionQuickPickItems, { canPickMany: true });
		if (selectedSubscriptionQuickPickItems && selectedSubscriptionQuickPickItems.length > 0) {
			await tree.refresh(node, false);

			selectedSubscriptions = selectedSubscriptionQuickPickItems.map((subscriptionItem) => subscriptionItem.subscription);
			await subscriptionFilterService.saveSelectedSubscriptions(accountNode.account, selectedSubscriptions);
		}
	});

	appContext.apiWrapper.registerCommand('azure.resource.refreshall', () => tree.notifyNodeChanged(undefined));

	appContext.apiWrapper.registerCommand('azure.resource.refresh', async (node?: TreeNode) => {
		await tree.refresh(node, true);
	});

	appContext.apiWrapper.registerCommand('azure.resource.signin', async (node?: TreeNode) => {
		appContext.apiWrapper.executeCommand('workbench.actions.modal.linkedAccount');
	});

	appContext.apiWrapper.registerCommand('azure.resource.connectsqlserver', async (node?: TreeNode) => {
		if (!node) {
			return;
		}

		const treeItem: azdata.TreeItem = await node.getTreeItem();
		if (!treeItem.payload) {
			return;
		}
		// Ensure connection is saved to the Connections list, then open connection dialog
		let connectionProfile = Object.assign({}, treeItem.payload, { saveProfile: true });
		const conn = await appContext.apiWrapper.openConnectionDialog(undefined, connectionProfile, { saveConnection: true, showDashboard: true });
		if (conn) {
			appContext.apiWrapper.executeCommand('workbench.view.connections');
		}
	});
}
