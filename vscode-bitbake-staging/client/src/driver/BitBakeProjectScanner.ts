/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import find from 'find'
import path from 'path'
import EventEmitter from 'events'
import * as vscode from 'vscode'

import { logger } from '../lib/src/utils/OutputLogger'

import {
  SCAN_RESULT_VERSION,
  type BitbakeScanResult,
  type DevtoolWorkspaceInfo,
  type ElementInfo,
  type LayerInfo,
} from '../lib/src/types/BitbakeScanResult'

import { type BitbakeDriver } from './BitbakeDriver'
import fs from 'fs'
import { runBitbakeTerminalCustomCommand } from '../ui/BitbakeTerminal'
import { bitbakeESDKMode } from './BitbakeESDK'
import { finishProcessExecution } from '../utils/ProcessUtils'
import { extractRecipeName, extractRecipeVersion } from '../lib/src/utils/files'

interface ScanStatus {
  scanIsRunning: boolean
  scanIsPending: boolean
}

/**
 * BitBakeProjectScanner
 */
export class BitBakeProjectScanner {
  public static readonly EventType = {
    SCAN_COMPLETE: 'scanComplete',
    START_SCAN: 'startScan'
  }

  private readonly _classFileExtension: string = 'bbclass'
  private readonly _includeFileExtension: string = 'inc'
  private readonly _recipesFileExtension: string = 'bb'
  private readonly _confFileExtension: string = 'conf'
  onChange: EventEmitter = new EventEmitter()

  /// The scan results stored per activeBuildConfiguration
  private _bitbakeScanResults: { [key: string]: BitbakeScanResult } = {}
  private readonly _bitbakeDriver: BitbakeDriver

  /// These attributes map bind mounts of the workDir to the host system if a docker container commandWrapper is used (-v).
  private containerMountPoint: string | undefined
  private hostMountPoint: string | undefined

  constructor (bitbakeDriver: BitbakeDriver) {
    this._bitbakeDriver = bitbakeDriver
  }

  private _scanStatus: ScanStatus = {
    scanIsRunning: false,
    scanIsPending: false
  }

  get activeScanResult (): BitbakeScanResult {
    const activeBuildConfiguration = this._bitbakeDriver.activeBuildConfiguration
    if (this._bitbakeScanResults[activeBuildConfiguration] === undefined) {
      this._bitbakeScanResults[activeBuildConfiguration] = {
        _classes: [],
        _includes: [],
        _layers: [],
        _overrides: [],
        _recipes: [],
        _workspaces: [],
        _confFiles: [],
        _bitbakeVersion: ''
      }
    }
    return this._bitbakeScanResults[activeBuildConfiguration]
  }

  get bitbakeDriver (): BitbakeDriver {
    return this._bitbakeDriver
  }

  public saveCacheResult(memento: vscode.Memento): Thenable<void> {
    const ret = memento.update('bitbake.ScanResults', this._bitbakeScanResults).then(() => {
      logger.debug('BitBake scan result saved to workspace state')
    })
    void memento.update('bitbake.ScanResultVersion', SCAN_RESULT_VERSION).then(() => {
      logger.debug('BitBake scan result version saved to workspace state')
    })
    return ret
  }

  public restoreCacheResult(memento: vscode.Memento) : void {
    const scanResult = memento.get('bitbake.ScanResults') as { [key: string]: BitbakeScanResult }
    const scanResultVersion = memento.get('bitbake.ScanResultVersion') as number
    if (scanResult !== undefined && scanResultVersion === SCAN_RESULT_VERSION) {
      this._bitbakeScanResults = scanResult
      logger.debug('BitBake scan result restored from workspace state')
      // No need to emit onChange, because this is called during the initialization, when nothing is listening
    } else {
      logger.debug('No valid BitBake scan result found in workspace state: ' + scanResultVersion + '!=' + SCAN_RESULT_VERSION)
    }
  }

  public needsContainerPathsResolution (): boolean {
    return this.containerMountPoint !== undefined
  }

  /// A quick scan to present devtool modify/reset results. A full rescan is required for .bbappends.
  async rescanDevtoolWorkspaces (): Promise<void> {
    logger.info('request rescanDevtoolWorkspaces')
    await this.scanDevtoolWorkspaces()
    this.onChange.emit(BitBakeProjectScanner.EventType.SCAN_COMPLETE, this.activeScanResult)
  }

  async rescanProject (): Promise<void> {
    logger.info('request rescanProject')

    if (!this._scanStatus.scanIsRunning) {
      this._scanStatus.scanIsRunning = true
      logger.info('start rescanProject')
      this.onChange.emit(BitBakeProjectScanner.EventType.START_SCAN)

      try {
        if (!bitbakeESDKMode) { // Has been set by sanity checking
          this.scanBitbakeVersion()
          await this.scanAvailableLayers()
          this.scanForClasses()
          this.scanForIncludeFiles()
          this.scanForConfFiles()
          await this.scanForRecipes()
          await this.scanRecipesAppends()
          await this.scanOverrides()
        }
        await this.scanDevtoolWorkspaces()
        if (!bitbakeESDKMode) this.parseAllRecipes()

        logger.info('scan ready')
        this.printScanStatistic()

        this.onChange.emit(BitBakeProjectScanner.EventType.SCAN_COMPLETE, this.activeScanResult)
      } catch (error) {
        logger.error(`scanning of project is aborted: ${error}`)
        this.onChange.emit(BitBakeProjectScanner.EventType.SCAN_COMPLETE, this.activeScanResult)
      }

      this._scanStatus.scanIsRunning = false

      if (this._scanStatus.scanIsPending) {
        this._scanStatus.scanIsPending = false
        await this.rescanProject()
      }
    } else {
      logger.info('scan is already running, set the pending flag')
      this._scanStatus.scanIsPending = true
    }
  }

  private async getContainerParentInodes (filepath: string): Promise<number[]> {
    const stdout = await this.executeBitBakeCommand(`f=${filepath}; while [[ $f != / ]]; do stat -c %i $f; f=$(realpath $(dirname "$f")); done;`, 20000)
    const regex = /^\d+$/gm
    const matches = stdout.match(regex)
    return (matches != null) ? matches.map((match) => parseInt(match)) : [NaN]
  }

  /// Find corresponding mount point inode in layerPath/hostWorkdir and all parents
  private async scanContainerMountPoint (layerPath: string, hostWorkdir: string): Promise<void> {
    this.containerMountPoint = undefined
    this.hostMountPoint = undefined

    if (fs.existsSync(layerPath)) {
      // We're not inside a container, or the container is not using a different workdir
      return
    }

    const containerDirInodes = await this.getContainerParentInodes(layerPath)
    let hostDir = hostWorkdir

    while (hostDir !== '/') {
      const hostDirInode = fs.statSync(hostDir).ino

      let containerIdx = 0
      let containerDir = layerPath
      while (containerDir !== '/') {
        const containerDirInode = containerDirInodes[containerIdx]
        logger.debug('Comparing container inodes: ' + containerDir + ':' + containerDirInode + ' ' + hostDir + ':' + hostDirInode)
        if (containerDirInode === hostDirInode) {
          this.containerMountPoint = containerDir
          this.hostMountPoint = hostDir
          logger.info(`Found container mount point: ${this.containerMountPoint} -> ${this.hostMountPoint}`)
          return
        }
        containerDir = path.dirname(containerDir)
        containerIdx++
      }
      hostDir = path.dirname(hostDir)
    }
  }

  private printScanStatistic (): void {
    logger.info('Scan results:')
    logger.info('******************************************************************')
    logger.info(`Layer:     ${this.activeScanResult._layers.length}`)
    logger.info(`Recipes:   ${this.activeScanResult._recipes.length}`)
    logger.info(`Inc-Files: ${this.activeScanResult._includes.length}`)
    logger.info(`bbclass:   ${this.activeScanResult._classes.length}`)
    logger.info(`conf Files:   ${this.activeScanResult._confFiles.length}`)
    logger.info(`overrides:   ${this.activeScanResult._overrides.length}`)
    logger.info(`Devtool-workspaces:   ${this.activeScanResult._workspaces.length}`)
  }

  private scanForClasses (): void {
    this.activeScanResult._classes = this.searchFiles(this._classFileExtension)
  }

  private scanForIncludeFiles (): void {
    this.activeScanResult._includes = this.searchFiles(this._includeFileExtension)
  }

  private scanForConfFiles (): void {
    this.activeScanResult._confFiles = this.searchFiles(this._confFileExtension)
  }

  private scanBitbakeVersion(): void {
    const bitbakeScriptPath = this.bitbakeDriver.bitbakeSettings.pathToBitbakeFolder + '/bin/bitbake'
    const bitbakeScriptContent = fs.readFileSync(bitbakeScriptPath, 'utf8')

    const versionRegex = /__version__ = "(\d+\.\d+\.\d+)"/
    const match = bitbakeScriptContent.match(versionRegex)
    if (match === null) {
      logger.error('Failed to find bitbake version')
      throw new Error('Failed to find bitbake version in ' + bitbakeScriptPath)
    }
    logger.info('Bitbake version: ' + match[1])

    this.activeScanResult._bitbakeVersion = match[1]
  }

  public async scanAvailableLayers (): Promise<void> {
    this.activeScanResult._layers = new Array < LayerInfo >()
    this.containerMountPoint = undefined

    const output = await this.executeBitBakeCommand('bitbake-layers show-layers')
    const outputLines = output.split(/\r?\n/g)

    const layersStartRegex = /^layer *path *priority$/
    const layersFirstLine = outputLines.findIndex(line => layersStartRegex.test(line))
    if (layersFirstLine === -1) {
      logger.error('Failed to find layers in bitbake-layers output')
      throw new Error('Failed to find layers in bitbake-layers output')
    }

    for (const element of outputLines.slice(layersFirstLine + 2)) {
      const tempElement = element.split(/\s+/)
      const layerElement = {
        name: tempElement[0],
        path: await this.resolveContainerPath(tempElement[1]),
        priority: parseInt(tempElement[2])
      }

      if ((layerElement.name !== undefined) && (layerElement.path !== undefined) && (layerElement.priority !== undefined)) {
        this.activeScanResult._layers.push(layerElement as LayerInfo)
      }
    }
  }

  private async resolveCorrespondingPath (inputPath: string | undefined, hostToContainer: boolean, quiet: boolean = false): Promise<string | undefined> {
    if (inputPath === undefined) {
      return undefined
    }
    if (this.containerMountPoint === undefined && !hostToContainer) {
      // Should only be called through scanAvailableLayers()
      const hostWorkdir = this.bitbakeDriver?.getBuildConfig('workingDirectory')
      if (typeof hostWorkdir !== 'string') {
        throw new Error('hostWorkdir is not a string')
      }
      await this.scanContainerMountPoint(inputPath, hostWorkdir)
    }
    const origMountPoint = hostToContainer ? this.hostMountPoint : this.containerMountPoint
    const destMountPoint = hostToContainer ? this.containerMountPoint : this.hostMountPoint
    const fileExistsFn = hostToContainer ? this.existsInContainer.bind(this) : fs.existsSync
    if (origMountPoint === undefined || destMountPoint === undefined) {
      return inputPath
    }
    const relativePath = path.relative(origMountPoint, inputPath)
    let resolvedPath = path.resolve(destMountPoint, relativePath)
    if (!await fileExistsFn(resolvedPath)) {
      // This makes it work with the default kas-container configuration (/work & /build volumes)
      resolvedPath = path.resolve(destMountPoint, relativePath.replace('../', ''))
    }
    if (!await fileExistsFn(resolvedPath)) {
      // Showing a modal here because this can only happend through the command devtool-update-recipe which is not used often
      if (!quiet) {
        await vscode.window.showErrorMessage(
          'Bitbake extension couldn\'t locate a file.', {
            modal: true,
            detail: `It looks like you are using the bitbake.commandWrapper setting to use a docker container.\n
Couldn't find ${inputPath} corresponding paths inside and outside of the container.\n
You should adjust your docker volumes to use the same URIs as those present on your host machine.`
          })
      }
      return resolvedPath
    }
    return resolvedPath
  }

  /// If a docker container is used, the workdir may be different from the host system.
  /// This function resolves the path to the host system.
  async resolveContainerPath (layerPath: string | undefined, quiet: boolean = false): Promise<string | undefined> {
    return await this.resolveCorrespondingPath(layerPath, false, quiet)
  }

  /// This function mirrors resolveContainerPath, but for the other direction.
  async resolveHostPath (containerPath: string | undefined, quiet: boolean = false): Promise<string | undefined> {
    return await this.resolveCorrespondingPath(containerPath, true, quiet)
  }

  private async existsInContainer (containerPath: string): Promise<boolean> {
    const process = runBitbakeTerminalCustomCommand(this._bitbakeDriver, 'test -e ' + containerPath, 'BitBake: Test file', true)
    const res = finishProcessExecution(process, async () => { await this.bitbakeDriver.killBitbake() })
    return (await res).status === 0
  }

  private searchFiles (pattern: string): ElementInfo[] {
    const elements: ElementInfo[] = new Array < ElementInfo >()

    for (const layer of this.activeScanResult._layers) {
      try {
        const files = find.fileSync(new RegExp(`.${pattern}$`), layer.path)
        for (const file of files) {
          const pathObj: path.ParsedPath = path.parse(file)

          const element: ElementInfo = {
            name: pathObj.name,
            path: pathObj,
            extraInfo: `layer: ${layer.name}`,
            layerInfo: layer
          }

          elements.push(element)
        }
      } catch (error) {
        logger.error(`find error: pattern: ${pattern} layer.path: ${layer.path} error: ${JSON.stringify(error)}`)
        throw error
      }
    }

    return elements
  }

  async scanForRecipes (): Promise<void> {
    this.activeScanResult._recipes = new Array < ElementInfo >()

    const output = await this.executeBitBakeCommand('bitbake-layers show-recipes')
    const splittedOutput = output.split(/\r?\n/g)
    // All recipes found will follow the line: === Available recipes: ===
    const startingIndex = splittedOutput.findIndex((line) => line.includes('Available recipes'))
    logger.debug(`Starting index: ${startingIndex}`)

    let outputRecipeSection = ''
    if (startingIndex === -1) {
      logger.error('Failed to find available recipes')
      throw new Error('Failed to find available recipes')
    } else {
      outputRecipeSection = splittedOutput.slice(startingIndex).join('\n')
    }

    /**
     * Example:
     * zstd:
        meta                 1.5.5
       virt-viewer:
        meta-virtualization  11.0 (skipped: one of 'wayland x11' needs to be in DISTRO_FEATURES)

       The ones that are followed by (skipped) are not included.
     */
    const recipeRegex = /(?<name>.+):\r?\n((?:\s+(?<layer>\S+)\s+(?<version>\S+)(?<skipped>\s+\(skipped[^\r\n]*\))?\r?\n)+)/g

    for (const match of outputRecipeSection.matchAll(recipeRegex)) {
      const name = match.groups?.name
      const layerName = match.groups?.layer
      const version = match.groups?.version
      const skipped = match.groups?.skipped

      if (name === undefined) {
        logger.error('[scanForRecipes] recipeName is undefined')
        continue
      }

      const extraInfo = [`layer: ${layerName}`, `version: ${version} `].join('\r\n')

      /**
       * The output of 'bitbake-layers show-layers' is like this:
       * layer                 path                                                              priority
         =================================================================================================
         core                  /home/projects/poky/meta                                          5

         The output of 'bitbake-layers show-recipes' is like this:
         acl:
         meta                 2.3.2

         Here 'meta' is used to refer to the layer instead of 'core'. So in such case we need to compare
         the basename of the path found in 'show-layers' with the layer name found in this function.
       */
      const layerInfo = this.activeScanResult._layers.find((layer) => {
        return layer.name === layerName || path.parse(layer.path).name === layerName
      })

      const element: ElementInfo = {
        name,
        extraInfo,
        layerInfo,
        version,
        skipped
      }

      this.activeScanResult._recipes.push(element)
    }

    await this.scanForRecipesPath()
  }

  async scanOverrides (): Promise<void> {
    const output = await this.executeBitBakeCommand('bitbake-getvar OVERRIDES')
    const outerReg = /\nOVERRIDES="(.*)"\r?\n/
    this.activeScanResult._overrides = output.match(outerReg)?.[1].split(':') ?? []
  }

  public async scanDevtoolWorkspaces (): Promise<void> {
    this.activeScanResult._workspaces = new Array < DevtoolWorkspaceInfo >()
    const output = await this.executeBitBakeCommand('devtool status')
    const regex = /^([^\s]+):\s([^\s]+)(?:\s\([^\s]+\))?$/gm
    let match
    while ((match = regex.exec(output)) !== null) {
      this.activeScanResult._workspaces.push({ name: match[1], path: match[2] })
    }
  }

  parseAllRecipes (): void {
    void vscode.commands.executeCommand('bitbake.parse-recipes')
  }

  private async scanForRecipesPath (): Promise<void> {
    const output = await this.executeBitBakeCommand('bitbake-layers show-recipes -f')
    const lines = output.split(/\r?\n/g)
    // Example output (indentation or skipped means not used):
    // We don't want to report the indented recipes, which are superseeded
    // However skipped recipes are still in context, even though not buildable.
    // Their skipped reason is already captured in ElementInfo.skipped
    /* === Available recipes: ===
     * /home/deribaucourt/Workspace/yocto-vscode/yocto/yocto-build/sources/poky/meta/recipes-core/busybox/busybox_1.36.2.bb
     *   /home/deribaucourt/Workspace/yocto-vscode/yocto/yocto-build/sources/poky/meta/recipes-core/busybox/busybox_1.36.1.bb
     *   /home/deribaucourt/Workspace/yocto-vscode/yocto/yocto-build/sources/poky/meta/recipes-core/busybox/busybox_1.36.3.bb
     * /home/deribaucourt/Workspace/yocto-vscode/yocto/yocto-build/sources/poky/meta-selftest/recipes-test/images/wic-image-minimal.bb (skipped: ...)
    */
    const regex = /^(?<filename>[\w/._-]+\.bb)(?:\s+\(skipped[^\r\n]*\))?$/
    const filenames = []
    for (const line of lines) {
      const match = line.match(regex)
      const filename = match?.groups?.filename
      if (filename !== null && filename !== undefined) {
        filenames.push(filename)
      }
    }
    if (filenames.length === 0) { return }

    // Sort by decreasing length to avoid partial matches
    filenames.sort((a, b) => b.length - a.length)
    this.activeScanResult._recipes.sort((a, b) => b.name.length - a.name.length)
    await this.assignRecipesPaths(filenames, this.activeScanResult._recipes, (a: string, b: string) => a === b)

    // Some recipes change their PN like gcc-source -> gcc-source-13.2
    // We allow the recipe to be found by just including part of the name
    const recipesWithoutPaths = this.activeScanResult._recipes.filter((recipe) => recipe.path === undefined)
    await this.assignRecipesPaths(filenames, recipesWithoutPaths, (a: string, b: string) => a.includes(b))
  }

  private async assignRecipesPaths (filePaths: string[], recipesArray: ElementInfo[], nameMatchFunc: (a: string, b: string) => boolean): Promise<void> {
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i]
      const recipePath = await this.resolveContainerPath(filePath.trim()) as string
      const recipeName = extractRecipeName(recipePath)
      const recipeVersion = extractRecipeVersion(recipePath)
      const recipe = recipesArray.find((element: ElementInfo): boolean => {
        return element.path === undefined && nameMatchFunc(element.name, recipeName)
      })
      if (recipe !== undefined) {
        recipe.path = path.parse(recipePath)
        // The recipe version may be overriden through PREFERRED_VERSION. This one is more accurate
        if (recipe.version !== recipeVersion) {
          recipe.version = recipeVersion
        }
      }
    }
  }

  private async scanRecipesAppends (): Promise<void> {
    const output = await this.executeBitBakeCommand('bitbake-layers show-appends')

    // Example:
    // \r\nbusybox_1.36.1.bb:\r\n  /home/user/yocto/sources/poky/meta-poky/recipes-core/busybox/busybox_%.bbappend
    const outerReg: RegExp = /\r?\n(.*\.bb):(?:\r?\n\s*\/.*\.bbappend)+/g

    for (const match of output.matchAll(outerReg)) {
      const fullRecipeNameAsArray: string[] = match[1].split('_')

      if (fullRecipeNameAsArray.length > 0) {
        const recipeName: string = fullRecipeNameAsArray[0].split('.')[0]
        const recipeVersion: string | undefined = fullRecipeNameAsArray[1]?.split('.bb')[0]

        const recipe: ElementInfo | undefined = this.activeScanResult._recipes.find((obj: ElementInfo): boolean => {
          return obj.name === recipeName
        })

        if (recipe !== undefined) {
          const innerReg: RegExp = /(\S*\.bbappend)/g

          for (const matchInner of match[0].matchAll(innerReg)) {
            if (recipe.appends === undefined) {
              recipe.appends = new Array < path.ParsedPath >()
            }
            if (bbappendVersionMatches(recipeVersion, recipe.version)) {
              const resolvedPath = await this.resolveContainerPath(matchInner[0])
              const parsedPath = path.parse(resolvedPath ?? matchInner[0])
              recipe.appends.push(parsedPath)
            }
          }
        }
      }
    }
  }

  private async executeBitBakeCommand (command: string, timeout?: number): Promise<string> {
    if (this._bitbakeDriver === undefined) {
      throw new Error('Bitbake driver is not set')
    }
    const result = await finishProcessExecution(runBitbakeTerminalCustomCommand(this._bitbakeDriver, command, 'BitBake: Scan Project', true),
      async () => { await this.bitbakeDriver.killBitbake() }, timeout)
    if (result.status !== 0) {
      logger.error(`Failed to execute bitbake command: ${command}`)
      throw new Error(`Failed to execute bitbake command: ${command}\r\n${result.stderr.toString()}`)
    }
    return result.output.toString()
  }
}

function bbappendVersionMatches (bbappendVersion: string | undefined, recipeVersion: string | undefined): boolean {
  if (bbappendVersion === undefined) {
    return true
  }
  if (bbappendVersion === '%') {
    return true
  }
  if (recipeVersion === undefined) {
    return bbappendVersion === undefined
  }
  return recipeVersion.startsWith(bbappendVersion)
}
