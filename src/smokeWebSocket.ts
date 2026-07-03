/**
 * WebSocket connection for Kidde/Ring smoke detectors at one Ring location.
 *
 * Ring's official clients only open this socket when a location has a Ring
 * Alarm hub, but the clap/tickets endpoint returns sensor_bluejay_* assets
 * for hubless Kidde Wi-Fi detectors too, and the socket works for them
 * (discovered in https://github.com/dgreif/ring/issues/1674).
 *
 * Flow:
 * 1. GET clap/tickets — returns assets, a host, and a one-time auth ticket
 * 2. Filter assets for kind sensor_bluejay_*
 * 3. Connect wss://{host}/ws?authcode={ticket}&ack=false
 * 4. Send DeviceInfoDocGetList per asset UUID → initial device docs
 * 5. Listen for DataUpdate messages → real-time alarm/battery state
 */

import WebSocket from 'ws';
import { APP_API_BASE } from './settings';
import { RingRestClient, Logger } from './ringRestClient';

const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const DEVICE_LIST_TIMEOUT_MS = 15_000;

export interface KiddeDeviceData {
  zid: string;
  name?: string;
  deviceType?: string;
  serialNumber?: string;
  batteryLevel?: number;
  batteryStatus?: string;
  acStatus?: string;
  commStatus?: string;
  tamperStatus?: string;
  smoke?: { alarmStatus?: string };
  co?: { alarmStatus?: string };
  components?: Record<string, { alarmStatus?: string; reading?: number } | undefined>;
  [key: string]: unknown;
}

interface TicketAsset {
  uuid: string;
  kind: string;
  status?: string;
}

interface TicketResponse {
  assets?: TicketAsset[];
  ticket: string;
  host: string;
}

export function isKiddeAsset(asset: TicketAsset): boolean {
  return (asset.kind ?? '').startsWith('sensor_bluejay');
}

export function isKiddeDeviceType(deviceType: string | undefined): boolean {
  return !!deviceType && deviceType.includes('sensor_bluejay');
}

/** Smoke-only models (RGSAR-RW / RGSDR-RW) have no CO sensor. */
export function isSmokeOnly(deviceType: string | undefined): boolean {
  return deviceType === 'sensor_bluejay_ws' || deviceType === 'comp.bluejay.sensor_bluejay_ws';
}

export function modelName(deviceType: string | undefined): string {
  const type = deviceType ?? '';
  if (type.includes('sensor_bluejay_wsc')) {
    return 'Smart Smoke + CO Alarm (Wired)';
  }
  if (type.includes('sensor_bluejay_ws')) {
    return 'Smart Smoke Alarm (Wired)';
  }
  if (type.includes('sensor_bluejay_sc')) {
    return 'Smart Smoke + CO Alarm (Battery)';
  }
  return type || 'Kidde Smart Alarm';
}

/**
 * Device docs arrive split across { general: { v2 } } and { device: { v1 } };
 * merge them into one flat object (same approach as ring-client-api).
 */
function flattenDeviceData(data: Record<string, any>): KiddeDeviceData {
  return {
    ...(data.general?.v2 ?? {}),
    ...(data.device?.v1 ?? {}),
  };
}

export class SmokeDetectorWebSocket {
  private assets: TicketAsset[] = [];
  private ws?: WebSocket;
  private disconnected = false;
  private consecutiveFailures = 0;
  private seq = 1;
  private devices: KiddeDeviceData[] = [];
  private receivedAssetLists = new Set<string>();
  private deviceListResolve?: (devices: KiddeDeviceData[]) => void;
  private deviceListTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    public readonly locationId: string,
    public readonly locationName: string,
    private readonly restClient: RingRestClient,
    private readonly log: Logger,
    private readonly onDeviceUpdate: (device: KiddeDeviceData) => void,
    private readonly onDevicesDiscovered: (devices: KiddeDeviceData[]) => void,
    private readonly refreshIntervalMs: number,
  ) {}

  get hasAssets(): boolean {
    return this.assets.length > 0;
  }

  /** Connect and return the initial device list for this location. */
  async connect(): Promise<KiddeDeviceData[]> {
    if (this.disconnected) {
      return [];
    }

    try {
      const ticketUrl =
        `${APP_API_BASE}clap/tickets` +
        `?locationID=${this.locationId}` +
        '&enableExtendedEmergencyCellUsage=true' +
        '&requestedTransport=ws';
      const ticketResponse = await this.restClient.request<TicketResponse>(ticketUrl);
      const supportedAssets = (ticketResponse.assets ?? []).filter(isKiddeAsset);

      this.assets = supportedAssets;
      this.receivedAssetLists = new Set();
      this.devices = [];

      if (!supportedAssets.length) {
        this.log.debug(`Location "${this.locationName}": no Kidde assets found`);
        return [];
      }

      this.log.debug(
        `Location "${this.locationName}": ${supportedAssets.length} asset(s) — ` +
        supportedAssets.map((a) => `${a.uuid} (${a.kind}, ${a.status ?? 'unknown'})`).join(', '),
      );

      const wsUrl = `wss://${ticketResponse.host}/ws?authcode=${ticketResponse.ticket}&ack=false`;
      const devices = await this.openSocket(wsUrl, supportedAssets);

      this.consecutiveFailures = 0;
      this.startRefreshTimer();
      this.log.info(`Location "${this.locationName}": discovered ${devices.length} device(s)`);
      return devices;
    } catch (err) {
      this.log.error(`WebSocket connect failed for "${this.locationName}": ${err}`);
      this.consecutiveFailures++;
      this.scheduleReconnect();
      return [];
    }
  }

  private openSocket(wsUrl: string, assets: TicketAsset[]): Promise<KiddeDeviceData[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.log.info(`WebSocket connected for location "${this.locationName}"`);
        for (const asset of assets) {
          this.sendMessage({ msg: 'DeviceInfoDocGetList', dst: asset.uuid });
        }
        this.deviceListResolve = (devices) => {
          if (!settled) {
            settled = true;
            resolve(devices);
          }
        };
        this.deviceListTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.log.warn(`Timed out waiting for full device list from "${this.locationName}"`);
            resolve([...this.devices]);
          }
        }, DEVICE_LIST_TIMEOUT_MS);
      });

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('error', (err) => {
        this.log.debug(`WebSocket error for "${this.locationName}": ${err}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', () => {
        this.log.debug(`WebSocket closed for "${this.locationName}"`);
        if (!settled) {
          settled = true;
          resolve([...this.devices]);
        }
        if (!this.disconnected) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleMessage(rawData: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    const message = parsed.msg;
    const channel = parsed.channel;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.datatype === 'HubDisconnectionEventType') {
      this.log.warn(`Ring requested reconnect for "${this.locationName}"`);
      this.scheduleReconnect();
      return;
    }

    const body: Record<string, any>[] = Array.isArray(message.body) ? message.body : [];

    // Initial device docs in response to DeviceInfoDocGetList
    if (message.msg === 'DeviceInfoDocGetList' && body.length) {
      this.receivedAssetLists.add(message.src ?? '');
      for (const data of body) {
        const flat = flattenDeviceData(data);
        const existing = this.devices.find((d) => d.zid === flat.zid);
        if (existing) {
          Object.assign(existing, flat);
        } else {
          this.devices.push(flat);
        }
      }
      if (this.assets.every((a) => this.receivedAssetLists.has(a.uuid))) {
        clearTimeout(this.deviceListTimer);
        this.deviceListResolve?.([...this.devices]);
        this.onDevicesDiscovered([...this.devices]);
      }
    }

    // Real-time state updates (alarm triggered, battery changed, ...)
    if (channel === 'DataUpdate' && message.datatype === 'DeviceInfoDocType' && body.length) {
      for (const data of body) {
        const flat = flattenDeviceData(data);
        if (flat.zid) {
          this.onDeviceUpdate(flat);
        }
      }
    }
  }

  /** Fallback poll: re-request device docs on the open socket. */
  private startRefreshTimer(): void {
    clearInterval(this.refreshTimer);
    if (this.refreshIntervalMs <= 0) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        for (const asset of this.assets) {
          this.sendMessage({ msg: 'DeviceInfoDocGetList', dst: asset.uuid });
        }
      }
    }, this.refreshIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.disconnected || this.reconnectTimer) {
      return;
    }
    this.closeSocket();

    this.consecutiveFailures++;
    const delayMs = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (this.consecutiveFailures - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.log.info(`Reconnecting "${this.locationName}" in ${delayMs / 1000}s (attempt ${this.consecutiveFailures})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.disconnected) {
        return;
      }
      const devices = await this.connect();
      if (devices.length) {
        this.onDevicesDiscovered(devices);
      }
    }, delayMs);
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    message.seq = this.seq++;
    this.ws.send(JSON.stringify({ channel: 'message', msg: message }));
  }

  private closeSocket(): void {
    clearTimeout(this.deviceListTimer);
    clearInterval(this.refreshTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = undefined;
    }
  }

  disconnect(): void {
    this.disconnected = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.closeSocket();
  }
}
