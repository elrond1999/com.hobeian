'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const driver = require('../drivers/ay-303z/driver.compose.json');

class FakeDevice {
  constructor() {
    this.values = {};
    this.settings = { soil_warning: 30 };
    this.store = {};
    this.logs = [];
    this.errors = [];
    this.error = (...args) => this.errors.push(args);
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
try {
  // Load only after installing the Homey runtime mocks.
  // eslint-disable-next-line global-require
  AY303ZDevice = require('../.homeybuild/drivers/ay-303z/device');
  // eslint-disable-next-line global-require
  ZG303ZDevice = require('../.homeybuild/drivers/zg-303z/device');
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

async function sleepyFixture(Device = AY303ZDevice, previous) {
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
  const endpoint = { clusters: { tuya: cluster }, handleFrame() {} };
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
