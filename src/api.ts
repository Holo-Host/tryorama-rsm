import * as _ from 'lodash'
const fs = require('fs').promises
const path = require('path')
const TOML = require('@iarna/toml')

import { Waiter, FullSyncNetwork } from '@holochain/hachiko'
import * as T from "./types"
import { Player } from "./player"
import logger from './logger';
import { Orchestrator } from './orchestrator';
import { promiseSerialObject } from './util';
import { getConfigPath, genConfig } from './config';


export class ScenarioApi {

  description: string

  _players: Array<Player>
  _uuid: string
  _orchestrator: Orchestrator
  _waiter: Waiter

  constructor(description: string, orchestrator: Orchestrator, uuid: string) {
    this.description = description
    this._players = []
    this._uuid = uuid
    this._orchestrator = orchestrator
    this._waiter = new Waiter(FullSyncNetwork)
  }

  players = (configs: T.ObjectS<T.GenConfigFn | T.EitherConductorConfig>, start?: boolean): Promise<T.ObjectS<Player>> => {
    const players = {}
    Object.entries(configs).forEach(([name, config]) => {
      players[name] = (async () => {
        const genConfigArgs = await this._orchestrator._genConfigArgs()
        const { configDir } = genConfigArgs
        // If an object was passed in, run it through genConfig first. Otherwise use the given function.
        const configBuilder = _.isFunction(config) ? (config as T.GenConfigFn) : genConfig(config as T.EitherConductorConfig)
        const configToml = await configBuilder(genConfigArgs, this._uuid)
        const configJson = TOML.parse(configToml)
        const { instances } = configJson

        await fs.writeFile(getConfigPath(configDir), configToml)

        const player = new Player({
          name,
          genConfigArgs,
          spawnConductor: this._orchestrator._spawnConductor,
          onJoin: () => instances.forEach(instance => this._waiter.addNode(instance.dna, name)),
          onLeave: () => instances.forEach(instance => this._waiter.removeNode(instance.dna, name)),
          onSignal: ({ instanceId, signal }) => {
            const instance = instances.find(c => c.id === instanceId)
            const dnaId = instance!.dna
            const observation = {
              dna: dnaId,
              node: name,
              signal
            }
            this._waiter.handleObservation(observation)
          },
        })
        if (start) {
          await player.spawn()
        }
        this._players.push(player)
        return player
      })()
    })
    return promiseSerialObject(players)
  }

  consistency = (players?: Array<Player>): Promise<void> => new Promise((resolve, reject) => {
    if (players) {
      throw new Error("Calling `consistency` with parameters is currently unsupported. See https://github.com/holochain/hachiko/issues/10")
    }
    this._waiter.registerCallback({
      // nodes: players ? players.map(p => p.name) : null,
      nodes: null,
      resolve,
      reject,
    })
  })

  /**
   * Only called externally when there is a test failure, 
   * to ensure that players/conductors have been properly cleaned up
   */
  _cleanup = (): Promise<void> => {
    return Promise.all(
      this._players.map(player => player.kill())
    ).then(() => { })
  }

}