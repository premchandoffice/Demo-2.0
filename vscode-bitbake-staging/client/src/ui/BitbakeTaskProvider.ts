/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode'
import { type BitbakeDriver } from '../driver/BitbakeDriver'
import { BitbakePseudoTerminal } from './BitbakeTerminal'

/// Reflects the task definition in package.json
export interface BitbakeTaskDefinition extends vscode.TaskDefinition {
  recipes?: string[]
  task?: string
  options?: {
    continue?: boolean
    force?: boolean
    parseOnly?: boolean
    env?: boolean // Recipe environment
  }
  specialCommand?: string
}

export class BitbakeCustomExecution extends vscode.CustomExecution {
  pty: BitbakePseudoTerminal | undefined
}

export class BitbakeTaskProvider implements vscode.TaskProvider {
  readonly bitbakeDriver: BitbakeDriver

  constructor (bitbakeDriver: BitbakeDriver) {
    this.bitbakeDriver = bitbakeDriver
  }

  provideTasks (): vscode.ProviderResult<vscode.Task[]> {
    return []
  }

  resolveTask (task: vscode.Task): vscode.ProviderResult<vscode.Task> | undefined {
    const bitbakeTaskDefinition: BitbakeTaskDefinition = task.definition

    const canResolveTask = (bitbakeTaskDefinition.recipes?.[0] !== undefined ||
    bitbakeTaskDefinition.options?.parseOnly === true ||
    bitbakeTaskDefinition.options?.env === true ||
    bitbakeTaskDefinition.specialCommand !== undefined)

    if (canResolveTask) {
      const bitbakeCommand = this.bitbakeDriver.composeBitbakeCommand(bitbakeTaskDefinition)
      const problemMatchers = ['$bitbake-ParseError', '$bitbake-Variable', '$bitbake-generic', '$bitbake-task-error', '$bitbake-UnableToParse', '$bitbake-non-existent-uri']

      const resolvedTask = new vscode.Task(
        task.definition,
        task.scope ?? vscode.TaskScope.Workspace,
        task.name,
        task.source ?? 'bitbake',
        new BitbakeCustomExecution(async (): Promise<vscode.Pseudoterminal> => {
          const pty = new BitbakePseudoTerminal(this.bitbakeDriver);
          (resolvedTask.execution as BitbakeCustomExecution).pty = pty
          void pty.runProcess(
            this.bitbakeDriver.spawnBitbakeProcess(bitbakeCommand),
            this.bitbakeDriver.composeBitbakeScript(bitbakeCommand))
          return pty
        }),
        problemMatchers
      )
      if ((bitbakeTaskDefinition.task === undefined || bitbakeTaskDefinition.task.includes('build')) &&
          bitbakeTaskDefinition.options?.parseOnly !== true) {
        resolvedTask.group = vscode.TaskGroup.Build
      }
      if (bitbakeTaskDefinition.task !== undefined && bitbakeTaskDefinition.task.includes('clean')) {
        resolvedTask.group = vscode.TaskGroup.Clean
      }
      if (bitbakeTaskDefinition.options?.parseOnly === true) {
        resolvedTask.presentationOptions.reveal = vscode.TaskRevealKind.Silent
        resolvedTask.presentationOptions.focus = false
      }
      return resolvedTask
    }
    return undefined
  }
}
