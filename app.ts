'use strict';

import Homey from 'homey';

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');
  }

  getSoilDiagnostics() {
    const devices: unknown[] = [];
    const drivers = this.homey.drivers.getDrivers();
    for (const id of ['ay-303z', 'zg-303z']) {
      for (const device of drivers[id]?.getDevices() ?? []) {
        const sensor = device as Homey.Device & { getDiagnosticsSnapshot(): unknown };
        try {
          devices.push(sensor.getDiagnosticsSnapshot());
        } catch (error) {
          devices.push({ name: device.getName(), driver: id, error: String(error) });
        }
      }
    }
    return {
      appVersion: this.homey.manifest.version,
      generatedAt: new Date().toISOString(),
      notes: [
        'Counters begin when this diagnostics version was installed; persisted observations survive restarts.',
        'Measurement counters are per received datapoint. Native cluster values and Tuya values are separate.',
        'A sent command is not a device confirmation. A reported value may predate the latest request; compare timestamps.',
        'Firmware is null when unavailable without querying the sleeping device.',
      ],
      devices,
    };
  }

};
