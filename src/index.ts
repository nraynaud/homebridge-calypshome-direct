import {API, Categories, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';
import http from 'http';
import fetch from 'node-fetch';
import {backOff} from 'exponential-backoff';
import {client as WebSocketClient} from 'websocket';

const PLATFORM_NAME = 'CalypshomeDirect';
const PLUGIN_NAME = 'homebridge-calypshome-direct';

const START_TIMESTAMP = Math.round(+new Date() / 1000);

/**
 * This is a direct connection Profalux CalypsHome plugin.
 * It connects to the webserver embedded in the box through the local network.
 */
class CalypshomeDirect implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  private WindowCovering = this.Service.WindowCovering;

  public readonly accessoriesPerEventId: { [eventId: string]: PlatformAccessory } = {};
  public readonly serverURL: URL;

  constructor(
    public readonly logger: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.serverURL = new URL(config.url);
    this.serverURL.pathname = '';
    this.api.on('didFinishLaunching', async () => {
      await this.refreshDevices();
      this.connectWebSocket(logger);
    });
  }

  /**
   * update the status displayed by homekit from the status sent by calyps'home
   */
  updateCoverState(accessory: PlatformAccessory, parsedStatus) {
    // do not call any "set" function here, we don't want to trigger any real world effect
    accessory.getService(this.Service.AccessoryInformation)!
      .updateCharacteristic(this.Characteristic.Manufacturer, parsedStatus.manufacturer_name)
      .updateCharacteristic(this.Characteristic.ConfiguredName, accessory.context.obj.name);
    accessory.getService(this.WindowCovering)!
      .updateCharacteristic(this.Characteristic.Name, accessory.context.obj.name)
      .updateCharacteristic(this.Characteristic.CurrentPosition, Number(parsedStatus.level))
      .updateCharacteristic(this.Characteristic.TargetPosition, Number(parsedStatus.level))
      .updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
  }

  configureAccessory(accessory: PlatformAccessory) {
    const wcService = accessory.getService(this.WindowCovering)
      || accessory.addService(this.WindowCovering);
    wcService.getCharacteristic(this.Characteristic.HoldPosition).onSet(async val => {
      val && await sendCommand(this.serverURL, accessory.context.obj.id, 'STOP', this.logger);
    });
    wcService.getCharacteristic(this.Characteristic.TargetPosition).onSet(async newLevel => {
      const previousLevel = Number(wcService.getCharacteristic(this.Characteristic.CurrentPosition).value!);
      this.updatePositionState(accessory, previousLevel, previousLevel, Number(newLevel));
      await sendCommand(this.serverURL, accessory.context.obj.id, 'LEVEL', this.logger, {level: String(newLevel)});
    });
    this.accessoriesPerEventId[accessory.context.obj.eventId] = accessory;
  }

  /**
   * refresh the displayed state of the shutters and register the newly found ones.
   */
  async refreshDevices() {
    const request = async () => {
      try {
        for (const obj of await getShutters(this.serverURL)) {
          let accessory = this.accessoriesPerEventId[obj.eventId];
          if (!accessory) {
            accessory = new this.api.platformAccessory(obj.name, this.api.hap.uuid.generate(obj.id), Categories.WINDOW_COVERING);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
          accessory.context.obj = obj;
          const parsedStatus = Object.fromEntries(accessory.context.obj.status.map(o => [o.name, o.value]));
          this.updateCoverState(accessory, parsedStatus);
        }
      } catch (e) {
        this.logger.error('refreshDevices crashed', e);
        throw e;
      }
    };
    await backOff(request, {jitter: 'full', maxDelay: 3 * 60 * 1000, numOfAttempts: 10, startingDelay: 1000});
  }

  /**
   * conects the websocket and try to reconnect on error.
   */
  connectWebSocket(logger) {
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
        const splitMessage = message.utf8Data.split(' ').map(frag => frag[0] === '@' ?
          Buffer.from(frag.substring(1), 'base64').toString() : frag);
        const eventId = splitMessage[6];
        if (eventId.endsWith('/level')) {
          const acc = this.accessoriesPerEventId[eventId.replace(/level$/, '')];
          const wcService = acc.getService(this.WindowCovering)!;
          const previousLevel = Number(wcService.getCharacteristic(this.Characteristic.CurrentPosition).value!);
          const newLevel = Number(splitMessage[7]);
          this.updatePositionState(acc, previousLevel, newLevel, newLevel);
          wcService.updateCharacteristic(this.Characteristic.CurrentPosition, newLevel);
        }
      });
      connection.sendUTF('p1 1 _web / login');
    });
    client.connect(wsURL, 'lws-mirror-protocol');
  }

  updatePositionState(acc, previousPosition: number, currentActualPosition: number, nextPosition: number) {
    // this function can be called before or after a move, so currentActualPosition is either previousPosition or nextPosition.
    const increasing = previousPosition < nextPosition;
    let newState;
    if (previousPosition === nextPosition
      || increasing && currentActualPosition === 100
      || !increasing && currentActualPosition === 0) {
      newState = this.Characteristic.PositionState.STOPPED;
      // we know we are stopped, but the move might have been triggered by a remote, in which case we didn't know the target position.
      acc.getService(this.WindowCovering)!.updateCharacteristic(this.Characteristic.TargetPosition, currentActualPosition);
    } else {
      newState = increasing ? this.Characteristic.PositionState.INCREASING : this.Characteristic.PositionState.DECREASING;
    }
    this.setPositionState(acc, newState);
  }

  setPositionState(acc, newState) {
    acc.getService(this.WindowCovering)!.updateCharacteristic(this.Characteristic.PositionState, newState);
    clearTimeout(acc.context.stateTimeout); // works with undefined
    acc.context.stateTimeout = undefined;
    const stopped = this.Characteristic.PositionState.STOPPED;
    if (newState !== stopped) {
      //in a few seconds come back and clear the moving state if not cancelled before.
      acc.context.stateTimeout = setTimeout(() => this.setPositionState(acc, stopped), 11000);
    }
  }
}

interface ProfaluxObject {
  id: string;
  name: string;
  type: string;
  eventId: string;
}

async function getShutters(serverUrl): Promise<ProfaluxObject[]> {
  const text = await postData(new URL('/m?a=getObjects', serverUrl), {type: 'Rolling_Shutter'});
  return (await JSON.parse(text).objects).filter(o => o.type === 'Rolling_Shutter');
}

async function sendCommand(rootUrl, objectId, command, logger, args?: Record<string, string>) {
  const payload = {action: command, id: objectId};
  if (args) {
    payload['args'] = JSON.stringify(args);
  }
  return await postData(new URL('/m?a=command', rootUrl), payload);
}

// weirdly I get an ECONNRESET error if I don't make this agent keepalive
const AGENT = new http.Agent({keepAlive: true});

// the calyps'home web server only accepts POST requests for some reason
async function postData(url, payload: { [key: string]: string } = {}) {
  const response = await fetch(url, {method: 'POST', body: new URLSearchParams(Object.entries(payload)), agent: AGENT});
  return await response.text();
}

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, CalypshomeDirect);
};
