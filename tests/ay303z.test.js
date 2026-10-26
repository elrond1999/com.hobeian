'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const driver = require('../drivers/ay-303z/driver.compose.json');
const manifest = require('../.homeycompose/app.json');

class FakeDevice {
  constructor() {
    this.values = {};
    this.settings = { soil_warning: 30 };
    this.store = {};
    this.logs = [];
    this.errors = [];
    this.error = (...args) => this.errors.push(args);
    this.timers = [];
    this.driver = { id: 'ay-303z' };
    this.homey = {
      manifest: { version: '1.0.11' },
      setInterval: (callback) => {
        this.timers.push(callback); return callback;
      },
      clearInterval: (callback) => {
        this.timers = this.timers.filter((timer) => timer !== callback);
      },
    };
  }

  getName() {
    return 'Test soil sensor';
  }

  log(...args) {
    this.logs.push(args);
  }

  getSettings() {
    return this.settings;
  }

  getStoreValue(key) {
    return this.store[key];
  }

  async setStoreValue(key, value) {
    this.store[key] = structuredClone(value);
  }

  async setAvailable() {
    return undefined;
  }

  getSetting(key) {
    return this.settings[key];
  }

  hasCapability() {
    return true;
  }

  async setCapabilityValue(key, value) {
    this.values[key] = value;
  }
}

function FakeCluster() {}
FakeCluster.addCluster = () => {};

// Load the real device logic without a Homey runtime or live Zigbee traffic.
const originalLoad = Module._load;
Module._load = function load(request, ...args) {
  if (request === 'homey-zigbeedriver') return { ZigBeeDevice: FakeDevice };
  if (request === 'zigbee-clusters') {
    return { Cluster: FakeCluster, ZCLDataTypes: {}, CLUSTER: { POWER_CONFIGURATION: { NAME: 'powerConfiguration' } } };
  }
  return originalLoad.call(this, request, ...args);
};
let AY303ZDevice;
let ZG303ZDevice;
let SoilApp;
try {
  const deviceLoad = Module._load;
  Module._load = function load(request, ...args) {
    if (request === 'homey') return { App: function FakeApp() {} };
    return deviceLoad.call(this, request, ...args);
  };
  // Load only after installing the Homey runtime mocks.
  // eslint-disable-next-line global-require
  AY303ZDevice = require('../.homeybuild/drivers/ay-303z/device');
  // eslint-disable-next-line global-require
  ZG303ZDevice = require('../.homeybuild/drivers/zg-303z/device');
  // eslint-disable-next-line global-require
  SoilApp = require('../.homeybuild/app');
} finally {
  Module._load = originalLoad;
}

function report(device, dp, value) {
  const data = Buffer.alloc(4);
  data.writeInt32BE(value);
  device.processDataPoint(dp, 2, data);
}

test('AY-303Z reports legacy measurements with correct units', () => {
  const device = new AY303ZDevice();
  report(device, 3, 42);
  report(device, 5, 235);
  report(device, 15, 87);
  report(device, 109, 61);
  assert.equal(device.values.measure_soil_moisture, 42);
  assert.equal(device.values.measure_temperature, 23.5);
  assert.equal(device.values.measure_battery, 87);
  assert.equal(device.values.measure_humidity, 61);
});

test('AY-303Z DP106 is an alarm and DP9 does not overwrite it', () => {
  const device = new AY303ZDevice();
  device.processDataPoint(106, 1, Buffer.from([1]));
  assert.equal(device.values.alarm_water, true);
  device.processDataPoint(9, 4, Buffer.from([0]));
  assert.equal(device.values.alarm_water, true);
  device.processDataPoint(106, 1, Buffer.from([0]));
  assert.equal(device.values.alarm_water, false);
});

test('AY-303Z soil reports preserve both hardware alarm states', () => {
  const device = new AY303ZDevice();
  device.processDataPoint(106, 1, Buffer.from([1]));
  report(device, 3, 80);
  assert.equal(device.values.measure_soil_moisture, 80);
  assert.equal(device.values.alarm_water, true);
  device.processDataPoint(106, 1, Buffer.from([0]));
  report(device, 3, 10);
  assert.equal(device.values.measure_soil_moisture, 10);
  assert.equal(device.values.alarm_water, false);
});

test('AY-303Z soil reports wait for the hardware alarm report', () => {
  const device = new AY303ZDevice();
  report(device, 3, 10);
  assert.equal(device.values.measure_soil_moisture, 10);
  assert.equal(device.values.alarm_water, undefined);
});

test('AY-303Z threshold changes write the setting without overriding the hardware alarm', async () => {
  const device = new AY303ZDevice();
  const writes = [];
  device.tuyaCluster = {
    setDatapointValue: async (dp, value) => writes.push({ dp, value }),
  };
  report(device, 3, 50);
  for (const [alarm, threshold] of [[true, 20], [false, 80]]) {
    device.processDataPoint(106, 1, Buffer.from([Number(alarm)]));
    await device.onSettings({
      oldSettings: { soil_warning: 30 },
      newSettings: { soil_warning: threshold },
      changedKeys: ['soil_warning'],
    });
    assert.equal(device.values.alarm_water, alarm);
  }
  assert.deepEqual(writes, [{ dp: 110, value: 20 }, { dp: 110, value: 80 }]);
});

test('ZG-303Z retains its local alarm for soil reports and threshold changes', async () => {
  const device = new ZG303ZDevice();
  report(device, 107, 10);
  assert.equal(device.values.alarm_water, true);
  report(device, 107, 50);
  assert.equal(device.values.alarm_water, false);
  await device.onSettings({
    oldSettings: { soil_warning: 30 },
    newSettings: { soil_warning: 80 },
    changedKeys: ['soil_warning'],
  });
  assert.equal(device.values.alarm_water, true);
});

test('AY-303Z settings use DP9 for Celsius and never write alarm DP106', async () => {
  const device = new AY303ZDevice();
  const writes = [];
  device.tuyaCluster = {
    setDatapointEnum: async (dp, value) => writes.push({ dp, value, type: 'enum' }),
    setDatapointValue: async (dp, value) => writes.push({ dp, value, type: 'value' }),
  };
  device.settings.temperature_calibration = -0.5;
  await device.applyDeviceSettings();
  assert.deepEqual(writes.find((write) => write.type === 'enum'), { dp: 9, value: 0, type: 'enum' });
  assert.equal(writes.some((write) => write.dp === 106), false);
  assert.deepEqual(writes.find((write) => write.dp === 104), { dp: 104, value: -5, type: 'value' });
  assert.deepEqual(writes.filter((write) => write.type === 'value').map((write) => write.dp), [111, 112, 110, 104, 105, 102]);
});

test('ZG-303Z retains its temperature-unit setting and alarm mapping', async () => {
  const device = new ZG303ZDevice();
  report(device, 1, 1);
  device.processDataPoint(106, 4, Buffer.from([0]));
  assert.equal(device.values.alarm_water, true);
  report(device, 14, 0);
  assert.equal(device.values.alarm_water, false);
  const units = [];
  device.tuyaCluster = {
    setDatapointEnum: async (dp, value) => units.push({ dp, value }),
    setDatapointValue: async () => {},
  };
  await device.applyDeviceSettings();
  assert.deepEqual(units, [{ dp: 106, value: 0 }]);
});

test('AY-303Z pairing accepts the padded manufacturer and excludes unrelated models', () => {
  assert.ok(driver.zigbee.manufacturerName.includes('AOYAN  '));
  assert.ok(driver.zigbee.manufacturerName.includes('AOYAN'));
  assert.deepEqual(driver.zigbee.productId, ['AY-303Z']);
});

async function sleepyFixture(Device = AY303ZDevice, previous, handleFrame) {
  const device = new Device();
  device.node = { receiveWhenIdle: false };
  if (previous) {
    device.store = structuredClone(previous.store);
    device.settings = { ...previous.settings };
  }
  const writes = [];
  const cluster = new EventEmitter();
  cluster.setDatapointValue = async (dp, value) => {
    writes.push({ dp, value });
    if (cluster.failDp === dp) throw new Error('Wake window closed');
  };
  cluster.setDatapointEnum = async (dp, value) => writes.push({ dp, value });
  const endpoint = {
    clusters: { tuya: cluster, temperatureMeasurement: new EventEmitter(), relativeHumidity: new EventEmitter() },
    handleFrame(clusterId, frame) {
      return handleFrame?.(cluster, clusterId, frame);
    },
  };
  await device.onNodeInit({ zclNode: { endpoints: { 1: endpoint } } });
  return {
    device, writes, cluster, endpoint,
  };
}

async function editSettings(device, changes) {
  const newSettings = { ...device.settings, ...changes };
  await device.onSettings({ oldSettings: device.settings, newSettings, changedKeys: Object.keys(changes) });
  device.settings = newSettings;
}

test('sleepy soil sensors retry only unsent edits after failure and across restart', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  for (const Device of [AY303ZDevice, ZG303ZDevice]) {
    const first = await sleepyFixture(Device);
    await editSettings(first.device, { temperature_sampling: 300, soil_sampling: 600 });
    assert.deepEqual(first.writes, []);
    first.cluster.failDp = 112;
    await first.device.onEndDeviceAnnounce();
    assert.ok(first.writes.some(({ dp }) => dp === 112));
    assert.equal(first.device.errors.length, 1);
    const restarted = await sleepyFixture(Device, first.device);
    assert.deepEqual(restarted.writes, []);
    now += 6000;
    await restarted.device.onEndDeviceAnnounce();
    assert.deepEqual(restarted.writes, [{ dp: 112, value: 600 }]);
    now += 6000;
    await restarted.device.onEndDeviceAnnounce();
    assert.equal(restarted.writes.length, 1);
  }
});

test('soil sensor edits survive restart before any wake and use the saved requested value', async () => {
  const first = await sleepyFixture();
  await editSettings(first.device, { humidity_calibration: -28 });
  const restarted = await sleepyFixture(AY303ZDevice, first.device);
  await restarted.device.onEndDeviceAnnounce();
  assert.deepEqual(restarted.writes, [{ dp: 105, value: -28 }]);
});

test('a newer edit survives an in-flight wake write and overlapping wakes do not duplicate it', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const { device, writes, cluster } = await sleepyFixture();
  await editSettings(device, { soil_sampling: 300 });
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const send = cluster.setDatapointValue;
  cluster.setDatapointValue = async (...args) => {
    entered();
    await gate;
    return send(...args);
  };
  const wake = device.onEndDeviceAnnounce();
  await started;
  await editSettings(device, { soil_sampling: 600 });
  now += 6000;
  await device.onEndDeviceAnnounce();
  release();
  await wake;
  cluster.setDatapointValue = send;
  now += 6000;
  await device.onEndDeviceAnnounce();
  assert.deepEqual(writes, [{ dp: 112, value: 300 }, { dp: 112, value: 600 }]);
});

test('reported settings distinguish matching and mismatching sensor values in diagnostics', async () => {
  const { device, endpoint } = await sleepyFixture();
  device.settings.soil_sampling = 300;
  for (const value of [60, 300]) {
    // Fixed Tuya report: ZCL header, status/transaction, DP112 VALUE, length4.
    const frame = Buffer.from([0x19, 1, 1, 0, 1, 112, 2, 0, 4, 0, 0, value >> 8, value & 255]);
    endpoint.handleFrame(0xef00, frame, {});
  }
  const reports = device.logs.filter(([message]) => message === 'Soil sensor reported setting');
  assert.deepEqual(reports.map(([, details]) => ({
    raw: details.rawValue, requested: details.requestedRawValue, matches: details.matchesRequested,
  })), [{ raw: 60, requested: 300, matches: false }, { raw: 300, requested: 300, matches: true }]);
});

function rawReport(endpoint, dp, value) {
  const frame = Buffer.alloc(13);
  Buffer.from([0x19, 1, 2, 0, 1, dp, 2, 0, 4]).copy(frame);
  frame.writeInt32BE(value, 9);
  endpoint.handleFrame(0xef00, frame, {});
}

test('late diagnostics retain requested, failed, sent and reported settings after a restart', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const first = await sleepyFixture();
  await editSettings(first.device, { soil_sampling: 300 });
  first.cluster.failDp = 112;
  await first.device.onEndDeviceAnnounce();
  now += 6000;
  first.cluster.failDp = undefined;
  await first.device.onEndDeviceAnnounce();
  rawReport(first.endpoint, 112, 300);
  now += 3600000;
  await first.device.timers[0]();
  const restarted = await sleepyFixture(AY303ZDevice, first.device);
  const state = restarted.device.getDiagnosticsSnapshot();
  assert.equal(state.settings.soil_sampling.requested, 300);
  assert.equal(state.settings.soil_sampling.reported, 300);
  assert.equal(state.settings.soil_sampling.attempts, 2);
  assert.equal(state.settings.soil_sampling.failures, 1);
  assert.deepEqual(state.events.map(({ kind }) => kind), ['requested', 'attempt', 'failed', 'attempt', 'sent', 'reported']);
  assert.deepEqual(state.pending, {});
  assert.equal(state.starts, 2);
  assert.deepEqual(restarted.writes, []);
});

test('diagnostics distinguish unchanged reports, changes, native values and unknown datapoints', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const {
    device, endpoint, cluster, writes,
  } = await sleepyFixture();
  rawReport(endpoint, 3, 37);
  // A duplicate cluster notification for the intercepted packet is not a new report.
  cluster.emit('response', { dp: 3, datatype: 2, data: Buffer.from([0, 0, 0, 37]) });
  now += 60000;
  rawReport(endpoint, 3, 37);
  now += 60000;
  rawReport(endpoint, 3, 36);
  endpoint.clusters.relativeHumidity.emit('attr.measuredValue', 9000);
  endpoint.clusters.temperatureMeasurement.emit('attr.measuredValue', 2230);
  rawReport(endpoint, 109, 52);
  rawReport(endpoint, 200, 1234);
  const state = device.getDiagnosticsSnapshot();
  const soil = state.channels['tuya.dp3.type2'];
  assert.equal(soil.count, 3);
  assert.equal(soil.changes, 1);
  assert.equal(soil.meanIntervalMs, 60000);
  assert.equal(soil.maxIntervalMs, 60000);
  assert.equal(soil.lastChangedAt, 220000);
  assert.equal(state.channels['native.humidity'].value, 9000);
  assert.equal(state.channels['native.temperature'].value, 2230);
  assert.equal(state.channels['unknown.dp200.type2'].value, '000004d2');
  assert.equal(device.values.measure_humidity, 52);
  assert.equal(device.values.measure_temperature, undefined);
  assert.deepEqual(writes, []);
});

test('diagnostics bound retained events and payloads while keeping the latest setting status', async () => {
  const { device, endpoint } = await sleepyFixture();
  await editSettings(device, { humidity_calibration: -28 });
  for (let value = 0; value < 80; value += 1) rawReport(endpoint, 112, value);
  endpoint.handleFrame(0x0405, Buffer.alloc(200, 0xaa), {});
  const state = device.getDiagnosticsSnapshot();
  assert.equal(state.settings.humidity_calibration.requested, -28);
  assert.equal(state.settings.soil_sampling.reported, 79);
  assert.equal(state.events.length, 32);
  assert.equal(state.frames.length, 8);
  assert.equal(state.frames[7].hex.length, 160);
  assert.equal(state.frames[7].truncated, true);
});

test('a later periodic summary includes earlier setting attempts without another write', async () => {
  const { device, writes } = await sleepyFixture();
  await editSettings(device, { temperature_sampling: 300 });
  await device.timers[0]();
  const [, json] = device.logs.find(([message]) => message === 'SOIL_DIAGNOSTICS');
  const summary = JSON.parse(json);
  assert.equal(summary.settings.temperature_sampling.requested, 300);
  assert.equal(summary.pending.temperature_sampling.value, 300);
  assert.equal(summary.frames, undefined);
  assert.deepEqual(writes, []);
  await device.onDeleted();
  assert.equal(device.timers.length, 0);
});

test('the authenticated diagnostics route exports current readings and history without sensor traffic', async () => {
  const { device, endpoint, writes } = await sleepyFixture();
  rawReport(endpoint, 5, 211);
  await device.timers[0]();
  await editSettings(device, { soil_sampling: 300 });
  const app = new SoilApp();
  app.homey = {
    manifest: { version: '1.0.11' },
    drivers: { getDrivers: () => ({ 'ay-303z': { getDevices: () => [device] } }) },
  };
  // eslint-disable-next-line global-require
  const api = require('../.homeybuild/api');
  const result = await api.getSoilDiagnostics({ homey: { app } });
  assert.equal(result.appVersion, '1.0.11');
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].name, 'Test soil sensor');
  assert.equal(result.devices[0].channels['tuya.dp5.type2'].value, 211);
  assert.equal(result.devices[0].settings.soil_sampling.requested, 300);
  assert.equal(result.devices[0].identity.firmware, null);
  assert.equal(manifest.api.getSoilDiagnostics.method, 'GET');
  assert.equal(manifest.api.getSoilDiagnostics.path, '/diagnostics');
  assert.notEqual(manifest.api.getSoilDiagnostics.public, true);
  assert.deepEqual(writes, []);
});

test('capability publication errors remain visible separately from incoming measurement reports', async () => {
  const { device, endpoint } = await sleepyFixture();
  device.setCapabilityValue = async () => {
    throw new Error('Homey rejected update');
  };
  rawReport(endpoint, 5, 211);
  await device.timers[0]();
  const state = device.getDiagnosticsSnapshot();
  assert.equal(state.channels['tuya.dp5.type2'].count, 1);
  assert.equal(state.channels['homey.measure_temperature'], undefined);
  assert.ok(state.errors.some(({ context, message }) => context === 'Capability measure_temperature' && message.includes('Homey rejected update')));
});

test('cluster event fallback survives empty or failed raw decoding without double-counting decoded packets', async () => {
  const cases = [
    Buffer.from([0x19, 1, 2, 0, 1]),
    Buffer.from([0x19, 1, 2, 0, 1, 5, 2, 0, 0]),
    Buffer.from([0x19, 1, 2, 0, 1, 5, 2, 0, 4, 0, 0, 0, 211]),
  ];
  for (const frame of cases) {
    const { device, endpoint } = await sleepyFixture(AY303ZDevice, undefined, (cluster) => {
      cluster.emit('response', {
        transid: 1, dp: 5, datatype: 2, data: Buffer.from([0, 0, 0, 211]),
      });
    });
    await endpoint.handleFrame(0xef00, frame, {});
    assert.equal(device.values.measure_temperature, 21.1);
    assert.equal(device.getDiagnosticsSnapshot().channels['tuya.dp5.type2'].count, 1);
  }
});
