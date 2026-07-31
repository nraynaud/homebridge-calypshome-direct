import {
  API,
  Categories,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import http from 'http';
import fetch, { RequestInit } from 'node-fetch';
import { backOff } from 'exponential-backoff';
import { client as WebSocketClient } from 'websocket';

const PLATFORM_NAME = 'CalypshomeDirect';
const PLUGIN_NAME = 'homebridge-calypshome-direct';
const START_TIMESTAMP = Math.round(+new Date() / 1000);

/** weirdly, I get an ECONNRESET error if I don't make this agent keepalive */
const AGENT = new http.Agent({ keepAlive: true });

/** the calyps'home web server only accepts POST requests for some reason
 *
 * @param url
 * @param payload
 */
async function postData(url: URL, payload: { [key: string]: string } | undefined = undefined) {
  const init: RequestInit = { method: 'POST', agent: AGENT };
  if (payload) {
    init.body = new URLSearchParams(Object.entries(payload));
  }
  const response = await fetch(url, init);
  return await response.text();
}

async function sendCommand(rootUrl: string | URL | undefined, objectId: string, command: string, logger: Logger, args?: Record<string, string>) {
  const payload: { [key: string]: string; } = {
    action: command, id: objectId,
  };
  if (args) {
    payload.args = JSON.stringify(args);
  }
  return await postData(new URL('/m?a=command', rootUrl), payload);
}

async function getShutters(serverUrl: string | URL | undefined, logger: Logger): Promise<ProfaluxObject[]> {
  const text = await postData(new URL('/m?a=getObjects', serverUrl), {});
  const res: { [key: string]: ProfaluxObject[] } = {};
  const objects = await JSON.parse(text).objects;
  for (const o of objects) {
    (res[o.type] || (res[o.type] = [])).push(o);
    logger.info('obj', o.status);
  }
  return res.Rolling_Shutter;
}

/**
 * This is a direct connection Profalux CalypsHome plugin.
 * It connects to the webserver embedded in the box through the local network.
 *
 * Notes:
 * - TargetPosition is unreliable because we don't receive it from the remotes, so we do our best around it.
 * - Calling the box http server too much crashes the box, so we prefer the Websocket.
 * - We receive events about once every 10s on the websocket, including the "level" of a shutter if it's moving or if it has moved since
 * last time.
 */
class CalypshomeDirect implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly WindowCovering: typeof Service.WindowCovering;

  public readonly accessoriesPerEventId: { [eventId: string]: PlatformAccessory } = {};
  public readonly serverURL: URL;

  constructor(
    public readonly logger: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api = api;
    this.serverURL = new URL(config.url);
    this.serverURL.pathname = '';
    this.api.on('didFinishLaunching', async () => {
      await this.refreshDevices();
      this.connectWebSocket(logger);
    });
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.WindowCovering = this.Service.WindowCovering;
  }

  /**
   * update the status displayed by homekit from the status sent by calyps'home
   */
  updateCoverState(accessory: PlatformAccessory, parsedStatus: { [x: string]: string }) {
    // do not call any "set" function here, we don't want to trigger any real world effect
    if (parsedStatus.manufacturer_name) {
      accessory.getService(this.Service.AccessoryInformation)!
        .updateCharacteristic(this.Characteristic.Manufacturer, parsedStatus.manufacturer_name);
    }
    accessory.getService(this.Service.AccessoryInformation)!
      .updateCharacteristic(this.Characteristic.ConfiguredName, accessory.context.obj.name);
    accessory.getService(this.WindowCovering)!
      .updateCharacteristic(this.Characteristic.Name, accessory.context.obj.name)
      .updateCharacteristic(this.Characteristic.CurrentPosition, Number(parsedStatus.level))
      .updateCharacteristic(this.Characteristic.TargetPosition, Number(parsedStatus.level))
      .updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
  }

  configureAccessory(accessory: PlatformAccessory) {
    accessory.getService(this.Service.AccessoryInformation)!.getCharacteristic(this.Characteristic.Identify)
      .on('set', async () => {
        const delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));
        try {
          await sendCommand(this.serverURL, accessory.context.obj.id, 'OPEN', this.logger);
          await delay(1000);
          await sendCommand(this.serverURL, accessory.context.obj.id, 'CLOSE', this.logger);
          await delay(1000);
        } finally {
          await sendCommand(this.serverURL, accessory.context.obj.id, 'STOP', this.logger);
        }
      });
    const wcService = accessory.getService(this.WindowCovering)
      || accessory.addService(this.WindowCovering);
    wcService.getCharacteristic(this.Characteristic.HoldPosition).on('set', async () => {
      await sendCommand(this.serverURL, accessory.context.obj.id, 'STOP', this.logger);
    });
    wcService.getCharacteristic(this.Characteristic.TargetPosition).onSet(async newLevel => {
      const previousLevel = Number(wcService.getCharacteristic(this.Characteristic.CurrentPosition).value!);
      this.updatePositionState(accessory, previousLevel, previousLevel, Number(newLevel));
      await sendCommand(this.serverURL, accessory.context.obj.id, 'LEVEL', this.logger, { level: String(newLevel) });
    });
    this.accessoriesPerEventId[accessory.context.obj.eventId] = accessory;
  }

  /**
   * refresh the displayed state of the shutters and register the newly found ones.
   */
  async refreshDevices() {
    const request = async () => {
      try {
        for (const obj of await getShutters(this.serverURL, this.logger)) {
          let accessory = this.accessoriesPerEventId[obj.eventId];
          if (!accessory) {
            accessory = new this.api.platformAccessory(obj.name, this.api.hap.uuid.generate(obj.id), Categories.WINDOW_COVERING);
            accessory.context.obj = obj;
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.configureAccessory(accessory);
          }
          accessory.context.obj = obj;
          const parsedStatus = Object.fromEntries(accessory.context.obj.status.map((o: {
            name: string;
            value: string;
          }) => [o.name, o.value]));
          this.updateCoverState(accessory, parsedStatus);
        }
      } catch (e) {
        this.logger.error('refreshDevices crashed', e);
        throw e;
      }
    };
    await backOff(request, { jitter: 'full', maxDelay: 3 * 60 * 1000, numOfAttempts: 10, startingDelay: 1000 });
  }

  /**
   * conects the websocket and try to reconnect on error.
   */
  connectWebSocket(logger: Logger) {
    const wsURL = new URL(this.serverURL);
    wsURL.protocol = 'ws:';
    const client = new WebSocketClient();
    client.on('connect', connection => {
      logger.info('WebSocket connected');
      let eventNum = 2;
      const keepAliveInterval = setInterval(() => {
        eventNum++;
        const date = Math.round(+new Date() / 1000);
        const timestamp = date - START_TIMESTAMP;
        connection.sendUTF(`p1 ${eventNum} /_web / event ${date} event/system/gateway/uptime ${timestamp}`);
      }, 20000);
      connection.on('error', (error) => {
        logger.warn('WebSocket Error: ', error);
        clearInterval(keepAliveInterval);
        this.connectWebSocket(logger);
      });
      connection.on('close', () => {
        logger.info('WebSocket Connection Closed');
        clearInterval(keepAliveInterval);
        this.connectWebSocket(logger);
      });
      connection.on('message', (message) => {
        // fragments are separated by spaces, fragments starting with @ are base64 encoded
        if (message.utf8Data) {
          const splitMessage = message.utf8Data.split(' ').map((frag: string) => frag[0] === '@' ?
            Buffer.from(frag.substring(1), 'base64').toString() : frag);
          const eventId = splitMessage[6];
          if (eventId.endsWith('/level')) {
            const acc = this.accessoriesPerEventId[eventId.replace(/level$/, '')];
            const wcService = acc.getService(this.WindowCovering)!;
            const previousLevel = Number(wcService.getCharacteristic(this.Characteristic.CurrentPosition).value!);
            const newLevel = Number(splitMessage[7]);
            wcService.updateCharacteristic(this.Characteristic.CurrentPosition, newLevel);
            this.updatePositionState(acc, previousLevel, newLevel, newLevel);
          }
        }
      });
      connection.sendUTF('p1 1 _web / login');
    });
    client.connect(wsURL.toString(), 'lws-mirror-protocol');
  }

  updatePositionState(acc: PlatformAccessory, previousPosition: number, currentActualPosition: number, nextPosition: number) {
    // this function can be called before or after a move, so currentActualPosition is either previousPosition or nextPosition.
    const increasing = previousPosition < nextPosition;
    let newState;
    if (previousPosition === nextPosition
      || increasing && currentActualPosition === 100
      || !increasing && currentActualPosition === 0) {
      newState = this.Characteristic.PositionState.STOPPED;
    } else {
      newState = increasing ? this.Characteristic.PositionState.INCREASING : this.Characteristic.PositionState.DECREASING;
    }
    this.setPositionState(acc, newState);
  }

  setPositionState(acc: PlatformAccessory, newState: number) {
    acc.getService(this.WindowCovering)!.updateCharacteristic(this.Characteristic.PositionState, newState);
    clearTimeout(acc.context.stateTimeout); // works with undefined
    acc.context.stateTimeout = undefined;
    const stopped = this.Characteristic.PositionState.STOPPED;
    if (newState !== stopped) {
      //in a few seconds come back and clear the moving state if not cancelled before.
      acc.context.stateTimeout = setTimeout(() => this.setPositionState(acc, stopped), 15000);
    } else {
      const currentLevel = Number(acc.getService(this.WindowCovering)!.getCharacteristic(this.Characteristic.CurrentPosition).value!);
      // we know we are stopped, but the move might have been triggered by a remote, in which case we didn't know the target position.
      acc.getService(this.WindowCovering)!.updateCharacteristic(this.Characteristic.TargetPosition, currentLevel);
    }
  }
}

interface ProfaluxObject {
  id: string;
  name: string;
  type: string;
  eventId: string;
}


export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, CalypshomeDirect);
};
