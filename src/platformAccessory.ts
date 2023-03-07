import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';

import {CalypshomeDirect} from './platform';
import http from 'http';

export class ShutterAccessory {
  private service: Service;

  constructor(
    private readonly platform: CalypshomeDirect,
    private readonly accessory: PlatformAccessory,
  ) {

    const parsedStatus = Object.fromEntries(accessory.context.obj.status.map(o => [o.name, o.value]));
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, parsedStatus.manufacturer_name);
    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.obj.name);

    this.service.setCharacteristic(this.platform.Characteristic.CurrentPosition, Number(parsedStatus.level));
    this.service.setCharacteristic(this.platform.Characteristic.TargetPosition, Number(parsedStatus.level));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState).onGet(this.getMoving.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition).onSet(async val => {
      if (val) {
        await this.sendCommand(this.platform.config.url, accessory.context.obj.id, 'STOP', this.platform.log);
      }
      return val;
    });
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).onSet(async val => {
      await this.sendCommand(this.platform.config.url, accessory.context.obj.id, 'LEVEL', this.platform.log, {level: String(val)});
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, Number(val));
    });
  }

  async getMoving(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.PositionState.STOPPED;
  }

  async sendCommand(url, objectId, command, logger, args: any = null) {
    logger.info('sending', command, args);
    return new Promise((resolve, reject) => {
      const argFragment = args ? 'args=' + encodeURIComponent(JSON.stringify(args)) + '&' : '';
      const payload = `action=${command}&${argFragment}id=${objectId}`;
      const req = http.request(new URL(`${url}/m?a=command`), {
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
          resolve(data);
        });
        res.on('error', reject);
      });
      req.on('error', (err) => {
        logger.info('err', err);
        reject(err);
      });
      req.write(payload, (e) => {
        if (e) {
          logger.info('e', e);
        }
        req.end();
      });
    });
  }
}
