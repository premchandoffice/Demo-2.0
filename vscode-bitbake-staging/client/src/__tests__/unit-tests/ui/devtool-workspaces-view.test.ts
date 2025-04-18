/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode'
import { type DevtoolWorkspaceTreeItem, DevtoolWorkspacesView } from '../../../ui/DevtoolWorkspacesView'
import { BitBakeProjectScanner } from '../../../driver/BitBakeProjectScanner'
import { type BitbakeScanResult } from '../../../lib/src/types/BitbakeScanResult'
import { BitbakeDriver } from '../../../driver/BitbakeDriver'
import { mockVscodeEvents } from '../../utils/vscodeMock'

jest.mock('vscode')

describe('Devtool Worskapces View', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should list devtool workspaces', (done) => {
    const contextMock = {
      subscriptions: {
        push: jest.fn()
      }
    } as unknown as vscode.ExtensionContext

    const scanResult: BitbakeScanResult = {
      _recipes: [{
        name: 'dropbear',
        path: {
          root: '/',
          dir: '/home/user/yocto/poky/meta/recipes-core/dropbear',
          base: 'dropbear_2022.83',
          ext: '.bb',
          name: 'dropbear'
        }
      }],
      _workspaces: [
        {
          name: 'dropbear',
          path: '/build/workspace/dropbear'
        }
      ],
    } as BitbakeScanResult

    const bitBakeProjectScanner = new BitBakeProjectScanner(new BitbakeDriver())

    vscode.window.registerTreeDataProvider = jest.fn().mockImplementation(
      async (viewId: string, treeDataProvider: vscode.TreeDataProvider<DevtoolWorkspaceTreeItem>): Promise<void> => {
        const rootTreeItem = await treeDataProvider.getChildren(undefined)
        expect(rootTreeItem).toBeDefined()
        expect(rootTreeItem?.length).toStrictEqual(2)
        const recipeItem = (rootTreeItem as DevtoolWorkspaceTreeItem[])[0]
        expect(recipeItem.workspace.name).toStrictEqual('dropbear')

        done()
      })
    mockVscodeEvents()

    const devtoolWorkspacesView = new DevtoolWorkspacesView(bitBakeProjectScanner)
    bitBakeProjectScanner.onChange.emit(BitBakeProjectScanner.EventType.SCAN_COMPLETE, scanResult)
    devtoolWorkspacesView.registerView(contextMock)
  })
})
