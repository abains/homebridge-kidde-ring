import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  DEVICE_API_BASE,
  DEFAULT_REFRESH_MINUTES,
  DEFAULT_LOW_BATTERY_THRESHOLD,
} from './settings';
import { RingRestClient, Ring2FARequired } from './ringRestClient';
import {
  SmokeDetectorWebSocket,
  KiddeDeviceData,
  isKiddeDeviceType,
} from './smokeWebSocket';
import { KiddeRingAccessory } from './accessory';
import { TokenStore } from './tokenStore';

interface RingLocation {
  location_id: string;
  name: string;
}

export class KiddeRingPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly lowBatteryThreshold: number;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, KiddeRingAccessory>();
  private readonly connections: SmokeDetectorWebSocket[] = [];
  private restClient?: RingRestClient;
  private tokenStore?: TokenStore;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.lowBatteryThreshold =
      typeof config.lowBatteryThreshold === 'number'
        ? config.lowBatteryThreshold
        : DEFAULT_LOW_BATTERY_THRESHOLD;

    if (!config.refreshToken && !(config.email && config.password)) {
      this.log.error(
        'Missing Ring credentials. Run "npx -p homebridge-kidde-ring kidde-ring-auth" to generate a ' +
        'refreshToken and add it to the platform config (or configure email/password for accounts without 2FA).',
      );
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.startup().catch((err) => {
        if (err instanceof Ring2FARequired) {
          this.log.error(
            `Ring requires two-factor authentication: ${err.prompt}. ` +
            'Run "npx -p homebridge-kidde-ring kidde-ring-auth" to complete 2FA and get a refreshToken.',
          );
        } else {
          this.log.error(`Failed to start Kidde Ring platform: ${err}`);
        }
      });
    });

    this.api.on('shutdown', () => {
      for (const connection of this.connections) {
        connection.disconnect();
      }
    });
  }

  /** Homebridge restores cached accessories before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async startup(): Promise<void> {
    this.tokenStore = new TokenStore(this.api.user.storagePath(), this.log);
    const configuredToken = this.config.refreshToken as string | undefined;

    this.restClient = new RingRestClient({
      refreshToken: this.tokenStore.resolve(configuredToken),
      email: this.config.email as string | undefined,
      password: this.config.password as string | undefined,
      log: this.log,
      onTokenUpdate: (newToken) => {
        this.log.debug('Ring refresh token rotated; persisting');
        this.tokenStore!.save(configuredToken, newToken);
      },
    });

    const data = await this.restClient.request<{ user_locations?: RingLocation[] }>(
      `${DEVICE_API_BASE}locations`,
    );
    let locations = data.user_locations ?? [];
    this.log.info(`Found ${locations.length} Ring location(s)`);

    const locationIds = this.config.locationIds as string[] | undefined;
    if (locationIds?.length) {
      locations = locations.filter((location) => locationIds.includes(location.location_id));
    }

    if (!locations.length) {
      this.log.warn('No Ring locations found for this account');
      return;
    }

    let allLocationsSucceeded = true;

    for (const location of locations) {
      const ws = new SmokeDetectorWebSocket(
        location.location_id,
        location.name,
        this.restClient,
        this.log,
        (device) => this.handleDeviceUpdate(device),
        (devices) => this.handleDevicesDiscovered(devices),
        this.refreshIntervalMs(),
      );

      const devices = await ws.connect();

      if (!ws.hasAssets) {
        this.log.debug(`Location "${location.name}": no Kidde alarms, skipping`);
        ws.disconnect();
        continue;
      }

      this.connections.push(ws);
      const kiddeDevices = devices.filter((d) => isKiddeDeviceType(d.deviceType));
      if (!kiddeDevices.length) {
        allLocationsSucceeded = false;
      }
      for (const device of kiddeDevices) {
        this.registerDevice(device);
      }
    }

    if (!this.handlers.size) {
      this.log.warn(
        'No Kidde/Ring smoke detectors found. Ensure the alarm is set up in the Ring app and online.',
      );
      return;
    }

    // Drop cached accessories for devices that no longer exist, but only
    // when every location produced a healthy device list.
    if (allLocationsSucceeded) {
      for (const [uuid, accessory] of this.cachedAccessories) {
        if (!this.handlers.has(uuid)) {
          this.log.info(`Removing stale accessory: ${accessory.displayName}`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.cachedAccessories.delete(uuid);
        }
      }
    }
  }

  private refreshIntervalMs(): number {
    const minutes =
      typeof this.config.refreshIntervalMinutes === 'number'
        ? this.config.refreshIntervalMinutes
        : DEFAULT_REFRESH_MINUTES;
    return Math.max(1, minutes) * 60_000;
  }

  private registerDevice(device: KiddeDeviceData): void {
    const uuid = this.api.hap.uuid.generate(`kidde-ring:${device.zid}`);

    if (this.handlers.has(uuid)) {
      this.handlers.get(uuid)!.update(device);
      return;
    }

    const cached = this.cachedAccessories.get(uuid);
    if (cached) {
      this.log.info(`Restoring Kidde alarm: ${device.name} (${device.deviceType})`);
      cached.context.device = device;
      this.handlers.set(uuid, new KiddeRingAccessory(this, cached, device));
      return;
    }

    this.log.info(`Adding new Kidde alarm: ${device.name} (${device.deviceType})`);
    const accessory = new this.api.platformAccessory(device.name || 'Kidde Alarm', uuid);
    accessory.context.device = device;
    this.handlers.set(uuid, new KiddeRingAccessory(this, accessory, device));
    this.cachedAccessories.set(uuid, accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  private handleDeviceUpdate(device: KiddeDeviceData): void {
    const uuid = this.api.hap.uuid.generate(`kidde-ring:${device.zid}`);
    const handler = this.handlers.get(uuid);
    if (handler) {
      this.log.debug(`Device update: ${device.name ?? device.zid}`);
      handler.update(device);
    } else if (isKiddeDeviceType(device.deviceType)) {
      this.log.info(`New device detected: ${device.name} (${device.deviceType})`);
      this.registerDevice(device);
    }
  }

  private handleDevicesDiscovered(devices: KiddeDeviceData[]): void {
    for (const device of devices) {
      if (isKiddeDeviceType(device.deviceType)) {
        this.registerDevice(device);
      }
    }
  }
}
