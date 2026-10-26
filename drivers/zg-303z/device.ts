'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';

// Import and register Tuya cluster
import { TuyaDataTypes, TUYA_CLUSTER_ID } from '../../lib/TuyaCluster';
import { decodeTuyaDpValuesFromZclFrame } from '../../lib/tuyaFrame';
import {
  clampPercent,
  computeWaterAlarmFromSoilMoisture,
  rawTemperatureTimes10ToCelsius,
  toTuyaPercentCalibration,
  toTuyaSamplingSeconds,
  toTuyaSoilWarningThresholdPercent,
  toTuyaTemperatureCalibrationTenths,
} from '../../lib/zg303z';
import { DP_HANDLERS, DP_WRITE, DEFAULTS } from '../../lib/zg303zDatapoints';
import SoilDiagnostics from '../../lib/soilDiagnostics';

const PENDING_SETTINGS_STORE_KEY = 'soilSensorPendingSettings';
const DIAGNOSTICS_STORE_KEY = 'soilSensorDiagnostics';
const DIAGNOSTICS_INTERVAL_MS = 120000;
const NATIVE_TEMPERATURE_CLUSTER = 0x0402;
const NATIVE_HUMIDITY_CLUSTER = 0x0405;
const SETTING_WRITES = {
  temperature_sampling: { dp: 'TEMP_SAMPLING_INTERVAL', convert: toTuyaSamplingSeconds, fallback: DEFAULTS.SAMPLING_SECONDS },
  soil_sampling: { dp: 'SOIL_SAMPLING_INTERVAL', convert: toTuyaSamplingSeconds, fallback: DEFAULTS.SAMPLING_SECONDS },
  soil_warning: { dp: 'SOIL_WARNING_THRESHOLD', convert: toTuyaSoilWarningThresholdPercent, fallback: DEFAULTS.SOIL_WARNING_PERCENT },
  temperature_calibration: { dp: 'TEMP_CALIBRATION', convert: toTuyaTemperatureCalibrationTenths, fallback: DEFAULTS.CALIBRATION },
  humidity_calibration: { dp: 'HUMIDITY_CALIBRATION', convert: toTuyaPercentCalibration, fallback: DEFAULTS.CALIBRATION },
  soil_calibration: { dp: 'SOIL_CALIBRATION', convert: toTuyaPercentCalibration, fallback: DEFAULTS.CALIBRATION },
} as const;
type SettingKey = keyof typeof SETTING_WRITES;
type PendingSetting = { value: number };
type RawTuyaReport = { transid?: number; datapoints: Set<string> };

module.exports = class ZG303ZDevice extends ZigBeeDevice {

  protected datapointHandlers = DP_HANDLERS;
  protected writeDatapoints: Record<keyof typeof DP_WRITE, number> = DP_WRITE;
  protected deriveWaterAlarmFromSoilMoisture = true;

  private tuyaCluster: any = null;
  private lastSoilMoisturePercent?: number;
  private pendingSettings: Partial<Record<SettingKey, PendingSetting>> = {};
  private settingsApplyInProgress = false;
  private pendingStoreWrite: Promise<void> = Promise.resolve();
  private endpoint1: any = null;
  private lastWakeHandledAt = 0;
  private diagnostics = new SoilDiagnostics();
  private diagnosticTimer?: NodeJS.Timeout;
  private diagnosticStoreWrite: Promise<void> = Promise.resolve();
  private rawTuyaReports = new Set<RawTuyaReport>();

  async onNodeInit({ zclNode }: { zclNode: any }) {
    this.log('ZG-303Z device initialized');
    this.pendingSettings = this.getStoreValue(PENDING_SETTINGS_STORE_KEY) ?? {};
    this.diagnostics = new SoilDiagnostics(this.getStoreValue(DIAGNOSTICS_STORE_KEY));
    const { node } = this as any;
    this.diagnostics.start({
      manufacturer: node?.manufacturerName ?? null,
      model: node?.productId ?? null,
      receiveWhenIdle: node?.receiveWhenIdle ?? null,
      firmware: node?.softwareBuildId ?? null,
      integrationVersion: this.homey.manifest.version,
    });
    if (this.diagnosticTimer) this.homey.clearInterval(this.diagnosticTimer);
    this.diagnosticTimer = this.homey.setInterval(() => {
      this.log('SOIL_DIAGNOSTICS', JSON.stringify(this.getDiagnosticsSnapshot(false)));
      return this.persistDiagnostics().catch(this.error);
    }, DIAGNOSTICS_INTERVAL_MS);
    await this.persistDiagnostics().catch(this.error);
    this.log('Soil sensor settings at startup', {
      configured: this.getSettings(),
      pending: this.pendingSettings,
    });

    // This Tuya device supports configuring sampling/calibration via datapoints on 0xEF00.

    // Log available endpoints and clusters for debugging
    this.log('Available endpoints:', Object.keys(zclNode.endpoints));

    for (const [endpointId, endpoint] of Object.entries(zclNode.endpoints)) {
      this.log(`Endpoint ${endpointId} clusters:`, Object.keys((endpoint as any).clusters));
    }

    // Get endpoint 1 and store for later use
    const endpoint = zclNode.endpoints[1];
    if (!endpoint) {
      this.error('Endpoint 1 not found');
      return;
    }
    this.endpoint1 = endpoint;
    for (const [name, channel] of [['temperatureMeasurement', 'native.temperature'], ['relativeHumidity', 'native.humidity']]) {
      endpoint.clusters[name]?.on('attr.measuredValue', (value: number) => this.diagnostics.sample(channel, value));
    }
    for (const attribute of ['manufacturerName', 'modelId', 'appVersion']) {
      endpoint.clusters.basic?.on(`attr.${attribute}`, (value: string | number) => this.diagnostics.identify(attribute === 'appVersion' ? 'deviceAppVersion' : attribute, value));
    }

    // Detect if this is a sleepy (battery-powered) device
    const isSleepy = this.isDeviceSleepy();
    this.log(`Device is ${isSleepy ? 'sleepy (battery-powered)' : 'always-on'}`);

    // Only send magic packet on first init (pairing), not on app restarts
    const isFirstInit = typeof (this as any).isFirstInit === 'function' ? (this as any).isFirstInit() : false;
    if (isFirstInit) {
      this.log('First init - sending Tuya magic packet');
      await this.configureMagicPacket(zclNode).catch(this.error);
    }

    // Try to get the Tuya cluster
    this.tuyaCluster = endpoint.clusters['tuya'] || endpoint.clusters[TUYA_CLUSTER_ID];

    if (this.tuyaCluster) {
      this.log('Tuya cluster found!');
      this.setupTuyaListeners();
    } else {
      this.log('Tuya cluster not found in named clusters, trying to bind...');

      // Try to bind the cluster manually
      try {
        await endpoint.bind('tuya');
        this.tuyaCluster = endpoint.clusters['tuya'];
        if (this.tuyaCluster) {
          this.log('Tuya cluster bound successfully');
          this.setupTuyaListeners();
        }
      } catch (err) {
        this.log('Could not bind Tuya cluster:', err);
      }
    }

    // Register for raw cluster commands on the Tuya cluster
    this.registerRawReportHandler(zclNode);

    // For sleepy devices, defer commands until device wakes up
    // For always-on devices, apply settings immediately
    if (isSleepy) {
      this.log('Device is sleepy - pending user settings will be sent on its next report or announce');
    } else {
      // Device is always-on, apply settings immediately
      if (this.tuyaCluster) {
        if (Object.keys(this.pendingSettings).length > 0) {
          await this.applyPendingSettings().catch(this.error);
        } else {
          await this.applyDeviceSettings().catch(this.error);
        }
      }
      await this.readBattery(endpoint).catch(this.error);
    }
  }

  private async applyDeviceSettings(): Promise<void> {
    if (!this.tuyaCluster) return;
    await this.tuyaCluster.setDatapointEnum?.(this.writeDatapoints.TEMP_UNIT, 0); // enforce Celsius
    for (const key of Object.keys(SETTING_WRITES) as SettingKey[]) {
      const config = SETTING_WRITES[key];
      await this.writeSetting(key, config.convert(this.getSetting(key) ?? config.fallback));
    }
  }

  private async writeSetting(key: SettingKey, value: number): Promise<void> {
    const dp = this.writeDatapoints[SETTING_WRITES[key].dp];
    this.log('Sending soil sensor setting', { key, dp, rawValue: value });
    this.diagnostics.setting({
      kind: 'attempt', key, dp, value,
    });
    await this.persistDiagnostics().catch(this.error);
    try {
      await this.tuyaCluster.setDatapointValue(dp, value);
      this.diagnostics.setting({
        kind: 'sent', key, dp, value,
      });
    } catch (error) {
      this.diagnostics.setting({
        kind: 'failed', key, dp, value, error: String(error).slice(0, 240),
      });
      this.persistDiagnostics().catch(this.error);
      throw error;
    }
    this.persistDiagnostics().catch(this.error);
    this.log('Soil sensor setting sent (device value not yet confirmed)', { key, dp, rawValue: value });
  }

  private persistDiagnostics(): Promise<void> {
    const snapshot = this.diagnostics.snapshot();
    const write = this.diagnosticStoreWrite.then(() => this.setStoreValue(DIAGNOSTICS_STORE_KEY, snapshot));
    this.diagnosticStoreWrite = write.catch(() => {});
    return write;
  }

  private async publishCapability(capability: string, value: number | boolean): Promise<void> {
    try {
      await this.setCapabilityValue(capability, value);
      this.diagnostics.sample(`homey.${capability}`, value);
    } catch (error) {
      this.diagnostics.error(`Capability ${capability}`, error);
      throw error;
    }
  }

  // Used by the authenticated app settings API; exporting never sends radio commands.
  getDiagnosticsSnapshot(includeFrames = true) {
    const state = this.diagnostics.snapshot();
    const now = Date.now();
    return {
      name: this.getName(),
      driver: this.driver.id,
      clusters: Object.keys(this.endpoint1?.clusters ?? {}),
      expectedTuyaDatapoints: this.datapointHandlers,
      generatedAt: new Date(now).toISOString(),
      ...state,
      configured: this.getSettings(),
      pending: { ...this.pendingSettings },
      lastFrameAgeMs: state.lastFrameAt === undefined ? null : Math.max(0, now - state.lastFrameAt),
      channels: Object.fromEntries(Object.entries(state.channels).map(([key, value]) => [key, {
        ...value,
        ageMs: Math.max(0, now - value.lastAt),
        meanIntervalMs: value.count < 2 ? null : Math.round(value.totalIntervalMs / (value.count - 1)),
      }])),
      frames: includeFrames ? state.frames : undefined,
      events: includeFrames ? state.events : state.events.slice(-6),
    };
  }

  private persistPendingSettings(): Promise<void> {
    // Serialize snapshots so an older save cannot overwrite a newer edit.
    const snapshot = { ...this.pendingSettings };
    const write = this.pendingStoreWrite.then(() => this.setStoreValue(PENDING_SETTINGS_STORE_KEY, snapshot));
    this.pendingStoreWrite = write.catch(() => {});
    return write;
  }

  private async applyPendingSettings(): Promise<void> {
    if (!this.tuyaCluster || this.settingsApplyInProgress) return;
    this.settingsApplyInProgress = true;
    try {
      for (const [key, pending] of Object.entries(this.pendingSettings) as [SettingKey, PendingSetting][]) {
        try {
          await this.writeSetting(key, pending.value);
        } catch (error) {
          this.error('Soil sensor setting write failed; retained for next wake', { key, rawValue: pending.value }, error);
          break;
        }
        // A newer edit of the same setting must survive this in-flight write.
        if (this.pendingSettings[key] === pending) {
          delete this.pendingSettings[key];
          try {
            await this.persistPendingSettings();
          } catch (error) {
            if (!this.pendingSettings[key]) this.pendingSettings[key] = pending;
            throw error;
          }
        }
      }
    } finally {
      this.settingsApplyInProgress = false;
    }
  }

  /**
   * Set up listeners for Tuya cluster events
   */
  private setupTuyaListeners() {
    if (!this.tuyaCluster) return;

    // Listen for datapoint reports
    this.tuyaCluster.on('reporting', (args: any) => {
      this.processTuyaReport(args);
    });

    this.tuyaCluster.on('response', (args: any) => {
      this.processTuyaReport(args);
    });

    this.tuyaCluster.on('datapoint', (args: any) => {
      this.processTuyaReport(args);
    });
  }

  /**
   * Register handler for raw Zigbee frames
   */
  private registerRawReportHandler(zclNode: any) {
    // Use zclNode's handleFrame capability to intercept raw frames
    const endpoint = zclNode.endpoints[1];
    if (!endpoint) return;

    // Intercept handleFrame for the Tuya cluster
    const originalHandleFrame = endpoint.handleFrame?.bind(endpoint);
    if (originalHandleFrame) {
      endpoint.handleFrame = async (clusterId: number, frame: Buffer, meta: any) => {
        let rawReport: RawTuyaReport | undefined;
        const observedClusters: number[] = [TUYA_CLUSTER_ID, NATIVE_TEMPERATURE_CLUSTER, NATIVE_HUMIDITY_CLUSTER];
        if (observedClusters.includes(clusterId)) {
          this.diagnostics.frame(clusterId, frame);
        }
        if (clusterId === TUYA_CLUSTER_ID) {
          rawReport = this.parseRawTuyaFrame(frame);
          this.rawTuyaReports.add(rawReport);

          // Device is awake since we received data - trigger wake handler
          this.onDeviceAwake().catch(this.error);
        }
        try {
          return await originalHandleFrame(clusterId, frame, meta);
        } finally {
          if (rawReport) this.rawTuyaReports.delete(rawReport);
        }
      };
      this.log('Registered raw frame handler for Tuya cluster');
    }

  }

  /**
   * Parse a raw Tuya frame
   */
  private parseRawTuyaFrame(frame: Buffer) {
    const report: RawTuyaReport = { datapoints: new Set() };
    try {
      const decoded = decodeTuyaDpValuesFromZclFrame(frame);
      report.transid = decoded.transid;
      if (decoded.dpValues.length === 0) {
        this.diagnostics.sample(`tuya.command${decoded.commandId}.withoutDatapoints`, decoded.status ?? -1);
        return report;
      }

      for (const dpValue of decoded.dpValues) {
        this.processDataPoint(dpValue.dp, dpValue.datatype, dpValue.data);
        report.datapoints.add(`${dpValue.dp}:${dpValue.datatype}:${dpValue.data.toString('hex')}`);
      }
    } catch (error) {
      this.diagnostics.error('Tuya frame decode', error);
      this.error('Error parsing raw Tuya frame:', error);
    }
    return report;
  }

  /**
   * Process a Tuya report
   */
  private processTuyaReport(args: any) {
    if (!args) return;

    const { dp, datatype, data } = args;

    if (typeof dp === 'number' && data) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from([data]);
      const key = `${dp}:${datatype || 0}:${bytes.toString('hex')}`;
      // Suppress only successful raw handling of this packet; decoding failures
      // and datapoints not handled by the raw decoder retain their fallback.
      const handled = [...this.rawTuyaReports].some((report) => (args.transid === undefined || report.transid === args.transid)
        && report.datapoints.has(key));
      if (!handled) this.processDataPoint(dp, datatype || 0, bytes);
    }
  }

  /**
   * Parse a raw value from Tuya datapoint data based on datatype
   */
  private parseDpValue(datatype: number, data: Buffer): number | boolean {
    switch (datatype) {
      case TuyaDataTypes.BOOL:
        return data.readUInt8(0) !== 0;
      case TuyaDataTypes.VALUE:
        if (data.length >= 4) return data.readInt32BE(0);
        if (data.length >= 2) return data.readInt16BE(0);
        return data.readUInt8(0);
      case TuyaDataTypes.ENUM:
        return data.readUInt8(0);
      default:
        if (data.length >= 4) return data.readInt32BE(0);
        if (data.length >= 2) return data.readUInt16BE(0);
        if (data.length >= 1) return data.readUInt8(0);
        throw new Error(`Unknown datatype ${datatype} or empty data`);
    }
  }

  /**
   * Process a Tuya datapoint value using the DP_HANDLERS mapping table
   */
  private processDataPoint(dp: number, datatype: number, data: Buffer) {
    const mapping = this.datapointHandlers[dp];
    if (!mapping) {
      this.diagnostics.sample(`unknown.dp${dp}.type${datatype}`, data.subarray(0, 80).toString('hex'));
      return;
    }
    const rawValue = this.parseDpValue(datatype, data);
    this.diagnostics.sample(`tuya.dp${dp}.type${datatype}`, rawValue);

    // Apply divideBy transformation if specified in mapping
    const value = mapping.divideBy && typeof rawValue === 'number'
      ? rawValue / mapping.divideBy
      : rawValue;

    // Dispatch based on handler type
    switch (mapping.handler) {
      case 'temperature':
        if (typeof rawValue === 'number') {
          const tempC = rawTemperatureTimes10ToCelsius(rawValue);
          if (this.hasCapability('measure_temperature')) {
            this.publishCapability('measure_temperature', tempC).catch(this.error);
          }
        }
        break;

      case 'soilMoisture':
        if (typeof value === 'number') {
          const soilMoisture = clampPercent(value);
          this.lastSoilMoisturePercent = soilMoisture;

          if (this.hasCapability('measure_soil_moisture')) {
            this.publishCapability('measure_soil_moisture', soilMoisture).catch(this.error);
          }

          // Some models use a hardware alarm instead of this local fallback.
          if (this.deriveWaterAlarmFromSoilMoisture) {
            const threshold = this.getSetting('soil_warning') ?? DEFAULTS.SOIL_WARNING_PERCENT;
            const alarm = computeWaterAlarmFromSoilMoisture({
              soilMoisturePercent: soilMoisture,
              thresholdPercent: threshold,
            });
            if (this.hasCapability('alarm_water')) {
              this.publishCapability('alarm_water', alarm).catch(this.error);
            }
          }
        }
        break;

      case 'battery':
        if (typeof value === 'number') {
          const battery = clampPercent(value);
          if (this.hasCapability('measure_battery')) {
            this.publishCapability('measure_battery', battery).catch(this.error);
          }
        }
        break;

      case 'humidity':
        if (typeof value === 'number') {
          const humidity = clampPercent(value);
          if (this.hasCapability('measure_humidity')) {
            this.publishCapability('measure_humidity', humidity).catch(this.error);
          }
        }
        break;

      case 'waterWarning':
        if (typeof value === 'number' || typeof value === 'boolean') {
          const alarm = value === 1 || value === true;
          if (this.hasCapability('alarm_water')) {
            this.publishCapability('alarm_water', alarm).catch(this.error);
          }
        }
        break;

      case 'setting':
        {
          const key = (Object.keys(SETTING_WRITES) as SettingKey[])
            .find((candidate) => this.writeDatapoints[SETTING_WRITES[candidate].dp] === dp);
          const config = key ? SETTING_WRITES[key] : undefined;
          const requested = config && key ? this.pendingSettings[key]?.value
            ?? this.diagnostics.requested(key) ?? config.convert(this.getSetting(key) ?? config.fallback) : undefined;
          const changed = this.diagnostics.setting({
            kind: 'reported', dp, key: key ?? `dp${dp}`, value, requested,
          });
          if (changed) this.persistDiagnostics().catch(this.error);
          this.log('Soil sensor reported setting', {
            dp,
            key,
            rawValue: value,
            requestedRawValue: requested,
            matchesRequested: requested === undefined ? undefined : requested === value,
          });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Read battery status
   */
  private async readBattery(endpoint: any) {
    if (!endpoint.clusters[CLUSTER.POWER_CONFIGURATION.NAME]) {
      this.log('PowerConfiguration cluster not available');
      return;
    }

    try {
      this.diagnostics.batteryRead();
      const batteryStatus = await endpoint.clusters[CLUSTER.POWER_CONFIGURATION.NAME].readAttributes(['batteryPercentageRemaining']);
      if (batteryStatus.batteryPercentageRemaining !== undefined) {
        const battery = Math.round(batteryStatus.batteryPercentageRemaining / 2);
        await this.publishCapability('measure_battery', battery);
      }
    } catch (err) {
      this.diagnostics.batteryRead(true);
      this.diagnostics.error('Battery read', err);
      this.log('Could not read battery (device may be sleeping):', err);
    }
  }

  /**
   * Handle setting changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }: {
    oldSettings: Record<string, any>;
    newSettings: Record<string, any>;
    changedKeys: string[];
  }): Promise<void> {
    this.log('Settings changed:', changedKeys);

    for (const key of Object.keys(SETTING_WRITES) as SettingKey[]) {
      if (!changedKeys.includes(key)) continue;
      const config = SETTING_WRITES[key];
      this.pendingSettings[key] = { value: config.convert(newSettings[key] ?? config.fallback) };
      this.diagnostics.setting({
        kind: 'requested', key, dp: this.writeDatapoints[config.dp], value: this.pendingSettings[key]!.value,
      });
      this.log('Queued soil sensor setting', { key, requested: newSettings[key], rawValue: this.pendingSettings[key]?.value });
    }
    await this.persistPendingSettings();
    await this.persistDiagnostics().catch(this.error);
    if (!this.isDeviceSleepy()) await this.applyPendingSettings();

    // Only models using the local fallback recompute before hardware confirms.
    if (this.deriveWaterAlarmFromSoilMoisture && changedKeys.includes('soil_warning')) {
      const value = newSettings['soil_warning'];
      if (typeof this.lastSoilMoisturePercent === 'number') {
        const alarm = computeWaterAlarmFromSoilMoisture({
          soilMoisturePercent: this.lastSoilMoisturePercent,
          thresholdPercent: value ?? DEFAULTS.SOIL_WARNING_PERCENT,
        });
        this.log(`Recomputed water alarm to ${alarm} after threshold change`);
        if (this.hasCapability('alarm_water')) {
          this.setCapabilityValue('alarm_water', alarm).catch(this.error);
        }
      }
    }
  }

  /**
   * Clean up on device removal
   */
  async onDeleted() {
    if (this.diagnosticTimer) this.homey.clearInterval(this.diagnosticTimer);
    this.log('ZG-303Z device deleted');
  }

  /**
   * Called when a sleepy device announces itself (wakes up and rejoins network)
   */
  async onEndDeviceAnnounce(): Promise<void> {
    this.log('Device announced (woke up from sleep)');
    await this.onDeviceAwake();
  }

  private async configureMagicPacket(zclNode: any): Promise<void> {
    const endpoints = Object.values(zclNode.endpoints || {}) as any[];
    const candidates = endpoints.filter((e) => e?.clusters?.[CLUSTER.BASIC.NAME]);
    for (const endpoint of candidates) {
      try {
        await endpoint.clusters[CLUSTER.BASIC.NAME].readAttributes([
          'manufacturerName',
          'zclVersion',
          'appVersion',
          'modelId',
          'powerSource',
          0xfffe,
        ]);
        this.log('Sent Tuya configureMagicPacket readAttributes');
        return;
      } catch (err) {
        this.log('Tuya configureMagicPacket readAttributes failed on endpoint, trying next:', err);
      }
    }
  }

  /**
   * Check if device is sleepy (battery-powered, not always listening)
   */
  private isDeviceSleepy(): boolean {
    return (this as any).node?.receiveWhenIdle === false;
  }

  /**
   * Centralized handler for device wake-up events.
   * Called from onEndDeviceAnnounce and handleFrame when data is received.
   * Debounced to avoid duplicate processing within a short window.
   */
  private async onDeviceAwake(): Promise<void> {
    const now = Date.now();
    const DEBOUNCE_MS = 5000;

    if (now - this.lastWakeHandledAt < DEBOUNCE_MS) {
      return;
    }
    this.lastWakeHandledAt = now;

    // Mark device as available
    await this.setAvailable().catch(this.error);

    // Only apply settings if user changed them while device was sleeping
    if (Object.keys(this.pendingSettings).length > 0) {
      this.log('Applying pending user settings...', this.pendingSettings);
      await this.applyPendingSettings().catch(this.error);
    }

    // Read battery status
    if (this.endpoint1) {
      await this.readBattery(this.endpoint1).catch(this.error);
    }
  }

};
