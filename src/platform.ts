import {API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';

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
    this.log.debug('Finished initializing platform:', this.config.url);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    getObjects(`${this.config.url}/m?a=getObjects`, this.log).then(objects => {
      for (const obj of objects.filter(o => o.type === 'Rolling_Shutter')) {
        const uuid = this.api.hap.uuid.generate(obj.id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          existingAccessory.context.obj = obj;
          new ShutterAccessory(this, existingAccessory);
        } else {
          this.log.info('Adding new accessory:', obj.name);
          const accessory = new this.api.platformAccessory(obj.name, uuid);
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
  if (logger) {
    logger.warn('postData', url, payload);
  }
  return new Promise<string>((resolve, reject) => {
    if (logger) {
      logger.warn('postData2', url, payload, Buffer.byteLength(payload));
    }
    const req = http.request(url, {
      'headers': {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
      'method': 'POST',
      'timeout': 3000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (logger) {
          logger.debug('postData4 resolve', data);
        }
        resolve(data);
      });
      res.on('error', e => {
        if (logger) {
          logger.warn('form error', e);
        }
        reject(e);
      });
    });
    if (logger) {
      logger.debug('postData3 url, payload', url, payload, Buffer.byteLength(payload));
    }
    req.on('error', e => {
      if (logger) {
        logger.warn('req form error', e);
      }
      reject(e);
    });
    req.write(payload, e => {
      if (e) {
        if (logger) {
          logger.warn('form error', e);
        }
        reject(e);
      } else {
        if (logger) {
          logger.warn('req.end()');
        }

      }
    });
    req.end();
  });
}

async function getObjects(url, logger?: Logger): Promise<[ProfaluxObject]> {
  if (logger) {
    logger.debug('getObjects url', url);
  }
  try {
    return JSON.parse(await postData(new URL(url), '', logger)).objects;
  } catch (e) {
    if (logger) {
      logger.error('getObjects error', e);
    }
    throw e;
  }
}