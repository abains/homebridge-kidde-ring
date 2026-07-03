import { PlatformAccessory, Service } from 'homebridge';
import { KiddeRingPlatform } from './platform';
import { KiddeDeviceData, isSmokeOnly, modelName } from './smokeWebSocket';

/**
 * One Kidde alarm exposed to HomeKit as a Smoke Sensor, a Carbon Monoxide
 * Sensor (on combo models), and a Battery service.
 */
export class KiddeRingAccessory {
  private readonly smokeService: Service;
  private readonly coService?: Service;
  private readonly batteryService: Service;
  private data: KiddeDeviceData;

  constructor(
    private readonly platform: KiddeRingPlatform,
    public readonly accessory: PlatformAccessory,
    initialData: KiddeDeviceData,
  ) {
    this.data = initialData;
    const { Service, Characteristic } = this.platform;
    const name = initialData.name || 'Kidde Alarm';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Kidde')
      .setCharacteristic(Characteristic.Model, modelName(initialData.deviceType))
      .setCharacteristic(Characteristic.SerialNumber, initialData.serialNumber || initialData.zid);

    this.smokeService =
      this.accessory.getService(Service.SmokeSensor) ||
      this.accessory.addService(Service.SmokeSensor, name);
    this.smokeService.setCharacteristic(Characteristic.Name, name);
    this.smokeService.getCharacteristic(Characteristic.SmokeDetected)
      .onGet(() => this.smokeDetected);
    this.smokeService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBattery);
    this.smokeService.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.fault);
    this.smokeService.getCharacteristic(Characteristic.StatusTampered)
      .onGet(() => this.tampered);

    if (isSmokeOnly(initialData.deviceType)) {
      // Remove a stale CO service if the cached accessory used to have one.
      const stale = this.accessory.getService(Service.CarbonMonoxideSensor);
      if (stale) {
        this.accessory.removeService(stale);
      }
    } else {
      this.coService =
        this.accessory.getService(Service.CarbonMonoxideSensor) ||
        this.accessory.addService(Service.CarbonMonoxideSensor, `${name} CO`);
      this.coService.setCharacteristic(Characteristic.Name, `${name} CO`);
      this.coService.getCharacteristic(Characteristic.CarbonMonoxideDetected)
        .onGet(() => this.coDetected);
      this.coService.getCharacteristic(Characteristic.CarbonMonoxideLevel)
        .onGet(() => this.coLevel);
      this.coService.getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() => this.lowBattery);
    }

    this.batteryService =
      this.accessory.getService(Service.Battery) ||
      this.accessory.addService(Service.Battery, `${name} Battery`);
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.batteryLevel);
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBattery);
    this.batteryService.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );

    this.pushState();
  }

  /** Apply a device document (initial or real-time update) to HomeKit. */
  update(data: KiddeDeviceData): void {
    this.data = { ...this.data, ...data };
    this.pushState();
  }

  private pushState(): void {
    const { Characteristic } = this.platform;
    this.smokeService.updateCharacteristic(Characteristic.SmokeDetected, this.smokeDetected);
    this.smokeService.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery);
    this.smokeService.updateCharacteristic(Characteristic.StatusFault, this.fault);
    this.smokeService.updateCharacteristic(Characteristic.StatusTampered, this.tampered);
    if (this.coService) {
      this.coService.updateCharacteristic(Characteristic.CarbonMonoxideDetected, this.coDetected);
      this.coService.updateCharacteristic(Characteristic.CarbonMonoxideLevel, this.coLevel);
      this.coService.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery);
    }
    this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, this.batteryLevel);
    this.batteryService.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery);
  }

  private alarmActive(kind: 'smoke' | 'co'): boolean {
    // State lives either in flat { smoke: { alarmStatus } } fields or in
    // components["alarm.smoke"] / components["alarm.co"], depending on firmware.
    const flat = this.data[kind]?.alarmStatus;
    const component = this.data.components?.[`alarm.${kind}`]?.alarmStatus;
    return (flat ?? component) === 'active';
  }

  private get smokeDetected(): number {
    const { Characteristic } = this.platform;
    return this.alarmActive('smoke')
      ? Characteristic.SmokeDetected.SMOKE_DETECTED
      : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }

  private get coDetected(): number {
    const { Characteristic } = this.platform;
    return this.alarmActive('co')
      ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
      : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
  }

  private get coLevel(): number {
    const reading = this.data.components?.['co.level']?.reading;
    return typeof reading === 'number' && reading >= 0 ? reading : 0;
  }

  private get batteryLevel(): number {
    const level = this.data.batteryLevel;
    if (typeof level !== 'number') {
      // Hardwired models (RGCUAR-RW) report a status string instead of a
      // percentage: 'full' | 'ok' | 'low' (backup AA cells).
      return this.data.batteryStatus === 'low' ? 10 : 100;
    }
    return Math.max(0, Math.min(100, level));
  }

  private get lowBattery(): number {
    const { Characteristic } = this.platform;
    const low = typeof this.data.batteryLevel === 'number'
      ? this.data.batteryLevel <= this.platform.lowBatteryThreshold
      : this.data.batteryStatus === 'low';
    return low
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private get fault(): number {
    const { Characteristic } = this.platform;
    const commStatus = this.data.commStatus;
    return commStatus && commStatus !== 'ok'
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;
  }

  private get tampered(): number {
    const { Characteristic } = this.platform;
    const tamperStatus = this.data.tamperStatus;
    return tamperStatus && tamperStatus !== 'ok'
      ? Characteristic.StatusTampered.TAMPERED
      : Characteristic.StatusTampered.NOT_TAMPERED;
  }
}
