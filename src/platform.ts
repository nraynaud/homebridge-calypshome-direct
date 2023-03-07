import {API, Categories, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {ShutterAccessory} from './platformAccessory';
import * as http from 'http';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CalypshomeDirect implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  discoverDevices() {
    getObjects(`${this.config.url}/m?a=getObjects`, this.log).then(objects => {
      for (const obj of objects.filter(o => o.type === 'Rolling_Shutter')) {
        const uuid = this.api.hap.uuid.generate(obj.id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        if (existingAccessory) {
          existingAccessory.context.obj = obj;
          new ShutterAccessory(this, existingAccessory);
        } else {
          const accessory = new this.api.platformAccessory(obj.name, uuid, Categories.WINDOW_COVERING);
          accessory.context.obj = obj;
          new ShutterAccessory(this, accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    });
  }
}

interface ProfaluxObject {
  id: string;
  name: string;
  type: string;
}

export async function postData(url, payload = '', logger?: Logger) {
  return new Promise<string>((resolve, reject) => {
    const agent = new http.Agent({
      // weirdly I get a ECONNRESET if I don't make this agent keepalive
      keepAlive: true,
    });
    const req = http.request(url, {
      agent: agent,
      'headers': {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
      'method': 'POST',
      'timeout': 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
      res.on('error', e => {
        if (logger) {
          // logging the error explicitly logs the underlying C errno, just raising the exception doesn't
          logger.warn('form error', e);
        }
        reject(e);
      });
    });
    req.setSocketKeepAlive(false);
    req.on('error', e => {
      if (logger) {
        // logging the error explicitly logs the underlying C errno, just raising the exception doesn't
        logger.warn('req form error', e);
      }
      reject(e);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function getObjects(url, logger?: Logger): Promise<[ProfaluxObject]> {
  try {
    return JSON.parse(await postData(new URL(url), '', logger)).objects;
  } catch (e) {
    if (logger) {
      // logging the error explicitly logs the underlying C errno, just raising the exception doesn't
      logger.warn('getObjects error', e);
    }
    throw e;
  }
}