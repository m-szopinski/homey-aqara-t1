'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import AqaraManufacturerSpecificCluster = require('../../lib/AqaraManufacturerSpecificCluster');
import aqara = require('../../lib/aqara');

// Manufacturer code used for Aqara/LUMI manufacturer-specific attributes.
const AQARA_MANUFACTURER_ID = 0x115f;

// Per the zigbee-herdsman-converters definition, the T2 (LLKZMK12LM) reports the
// energy struct key (149) in Wh, so it is scaled to kWh (÷1000). Other keys match
// the shared defaults.
const MEASUREMENTS: { [key: number]: { capability: string; scale: number } } = {
  149: { capability: 'meter_power', scale: 0.001 }, // energy, Wh -> kWh
  150: { capability: 'measure_voltage', scale: 0.1 }, // 0.1 V
  151: { capability: 'measure_current', scale: 0.001 }, // mA -> A
  152: { capability: 'measure_power', scale: 1 }, // W
};

export = class DualRelayModuleT2 extends ZigBeeDevice {

  async onNodeInit() {
    this.enableDebug();
    this.printNode();

    // Relay L1 on endpoint 1 (uses the built-in onoff system handler).
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      endpoint: 1,
      getOpts: { getOnStart: true },
      reportOpts: {
        configureAttributeReporting: { minInterval: 0, maxInterval: 3600, minChange: 0 },
      },
    });

    // Relay L2 on endpoint 2. Sub-capabilities do not get the system handler
    // automatically, so the onOff cluster get/set/report mapping is supplied.
    if (this.hasCapability('onoff.l2')) {
      this.registerCapability('onoff.l2', CLUSTER.ON_OFF, {
        endpoint: 2,
        get: 'onOff',
        getOpts: { getOnStart: true },
        set: (value: boolean) => (value ? 'setOn' : 'setOff'),
        setParser: () => ({}),
        report: 'onOff',
        reportParser: (value: boolean) => value,
        reportOpts: {
          configureAttributeReporting: { minInterval: 0, maxInterval: 3600, minChange: 0 },
        },
      });
    }

    // Internal device temperature (endpoint 1).
    if (this.hasCapability('measure_temperature')) {
      this.registerCapability('measure_temperature', CLUSTER.DEVICE_TEMPERATURE, {
        endpoint: 1,
        getOpts: { getOnStart: true },
        reportOpts: {
          configureAttributeReporting: { minInterval: 60, maxInterval: 3600, minChange: 1 },
        },
      });
    }

    // Power/energy/voltage/current metering — reported as the sum of both relays
    // inside the Aqara "lifeline" struct (cluster 0xFCC0, attribute 0xF7).
    const aqaraCluster = this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME];
    aqaraCluster.on('attr.aqaraLifeline', (value: Buffer | string) => {
      try {
        this.parseLifelineReport(value);
      } catch (err) {
        this.error('Failed to parse Aqara lifeline report:', err);
      }
    });
    aqaraCluster.readAttributes(['aqaraLifeline'])
      .then((res: { aqaraLifeline?: Buffer | string }) => {
        if (res?.aqaraLifeline != null) this.parseLifelineReport(res.aqaraLifeline);
      })
      .catch((err: Error) => this.log('Initial lifeline read failed (will rely on reports):', err.message));

    // S1/S2 input detection (HA: lumiAction on l1/l2). The wired switches report
    // actuations on the genMultistateInput cluster; map the available endpoints
    // in ascending order to S1 then S2 and flip the read-only onoff.s1/onoff.s2.
    const multistateEndpoints = Object.keys(this.zclNode.endpoints)
      .filter((ep) => this.zclNode.endpoints[ep]?.clusters?.multistateInput)
      .sort((a, b) => Number(a) - Number(b));
    multistateEndpoints.forEach((ep, index) => {
      const channel = index === 0 ? 's1' : 's2';
      this.log(`[${channel}] listening on multistateInput, endpoint ${ep}`);
      this.zclNode.endpoints[ep].clusters.multistateInput.on('attr.presentValue', (presentValue: number) => {
        this.handleInputReport(channel, presentValue)
          .catch((err: Error) => this.error(`Failed to handle ${channel} report:`, err));
      });
    });

    // Apply the stored manufacturer-cluster preferences to the device. Attribute
    // ids and value mappings follow the zigbee-herdsman-converters definitions.
    await this.applyAqaraSettings({
      power_outage_memory: this.getSetting('power_outage_memory') ?? true,
      interlock: this.getSetting('interlock') ?? false,
      operation_mode_l1: this.getSetting('operation_mode_l1') ?? 'control_relay',
      operation_mode_l2: this.getSetting('operation_mode_l2') ?? 'control_relay',
      switch_type: this.getSetting('switch_type') ?? 'toggle',
      work_mode: this.getSetting('work_mode') ?? 'power',
    }).catch((err: Error) => this.error('Failed to apply settings on init:', err));

    this.log('Dual Relay Module T2 (lumi.switch.acn047) has been initialized');
  }

  /**
   * Handle a genMultistateInput presentValue report from an S1/S2 input.
   * Value 1 = actuation → flip the matching read-only capability and fire the
   * Flow trigger. Mirrors the Single Switch Module T1 behaviour.
   */
  async handleInputReport(channel: string, presentValue: number) {
    this.log(`[${channel}] presentValue =`, presentValue);
    if (presentValue !== 1) return;

    const capability = `onoff.${channel}`;
    if (!this.hasCapability(capability)) return;

    const next = !this.getCapabilityValue(capability);
    await this.setCapabilityValue(capability, next);

    const triggerId = `t2_${channel}_turned_${next ? 'on' : 'off'}`;
    this.homey.flow.getDeviceTriggerCard(triggerId)
      .trigger(this, {}, {})
      .catch((err: Error) => this.error(`Failed to trigger ${triggerId}:`, err));
  }

  /**
   * Map the Homey settings to Aqara 0xFCC0 attributes and write the given keys.
   * Attribute ids/values: operation_mode 0x0200 {decoupled:0, control_relay:1},
   * switch_type 0x000A {toggle:1, momentary:2}, interlock 0x02D0 (bool),
   * work_mode 0x0289 {power:0, pulse:1, dry:3}, power_outage_memory 0x0201.
   */
  async applyAqaraSettings(values: { [key: string]: boolean | string | number }) {
    // Device-wide attributes live on endpoint 1's manufacturer cluster.
    const ep1: { [name: string]: number | boolean } = {};
    if ('power_outage_memory' in values) ep1.aqaraSwitchPowerOutageMemory = Boolean(values.power_outage_memory);
    if ('interlock' in values) ep1.aqaraInterlock = Boolean(values.interlock);
    if ('switch_type' in values) ep1.aqaraSwitchType = values.switch_type === 'momentary' ? 2 : 1;
    if ('operation_mode_l1' in values) ep1.aqaraSwitchOperationMode = values.operation_mode_l1 === 'decoupled' ? 0 : 1;
    if ('work_mode' in values) {
      const workModes: { [key: string]: number } = { power: 0, pulse: 1, dry: 3 };
      ep1.aqaraWorkMode = workModes[String(values.work_mode)] ?? 0;
    }

    const writes: Promise<unknown>[] = [];
    if (Object.keys(ep1).length > 0) writes.push(this.writeAqaraAttributes(1, ep1));

    // The L2 operation mode is written to the manufacturer cluster on endpoint 2.
    if ('operation_mode_l2' in values) {
      writes.push(this.writeAqaraAttributes(2, {
        aqaraSwitchOperationMode: values.operation_mode_l2 === 'decoupled' ? 0 : 1,
      }));
    }

    await Promise.all(writes);
  }

  /**
   * Write attributes to the Aqara manufacturer cluster (0xFCC0) on a given
   * endpoint, if that endpoint exposes the cluster.
   */
  async writeAqaraAttributes(endpoint: number, attributes: { [name: string]: number | boolean }) {
    const cluster = this.zclNode.endpoints[endpoint]?.clusters?.[AqaraManufacturerSpecificCluster.NAME];
    if (!cluster) {
      this.log(`Aqara cluster not present on endpoint ${endpoint}; skipping`, attributes);
      return;
    }
    await cluster.writeAttributes(attributes, { manufacturerId: AQARA_MANUFACTURER_ID });
  }

  /**
   * Decode the Aqara lifeline struct and update the metering capabilities.
   */
  parseLifelineReport(value: Buffer | string) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    const data = aqara.parseAqaraStruct(buffer);

    this.log('[lifeline] raw hex:', buffer.toString('hex'));
    this.log('[lifeline] parsed keys:', JSON.stringify(data));

    for (const [key, { capability, scale }] of Object.entries(MEASUREMENTS)) {
      const raw = data[Number(key)];
      if (raw == null || !this.hasCapability(capability)) continue;
      this.setCapabilityValue(capability, raw * scale)
        .catch((err: Error) => this.error(`Failed to set ${capability}:`, err));
    }
  }

  /**
   * Handle settings changes from the Homey UI: write only the changed keys.
   */
  async onSettings({ newSettings, changedKeys }: {
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }) {
    const managed = ['power_outage_memory', 'interlock', 'operation_mode_l1', 'operation_mode_l2', 'switch_type', 'work_mode'];
    const changed = changedKeys.filter((key) => managed.includes(key));
    if (changed.length === 0) return;

    const values: { [key: string]: boolean | string | number } = {};
    for (const key of changed) values[key] = newSettings[key] as boolean | string | number;
    await this.applyAqaraSettings(values);
  }

};
