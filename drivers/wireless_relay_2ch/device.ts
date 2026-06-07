'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import aqara = require('../../lib/aqara');

// Legacy LUMI devices report their packed measurement struct on the Basic
// cluster (0x0000), manufacturer attribute 0xFF01 (= 65281). zigbee-clusters
// emits unknown attributes as `attr.<id>`.
const LUMI_LEGACY_ATTR_EVENT = 'attr.65281';

// Struct key carrying the internal device temperature (°C, direct value).
const DEVICE_TEMPERATURE_KEY = 3;

// Per zigbee-herdsman-converters, LLKZMK11LM reports current already in amps, so
// key 151 is taken as-is (other LUMI modules report mA and scale by 0.001).
const MEASUREMENTS: { [key: number]: { capability: string; scale: number } } = {
  149: { capability: 'meter_power', scale: 1 }, // energy, kWh
  150: { capability: 'measure_voltage', scale: 0.1 }, // 0.1 V
  151: { capability: 'measure_current', scale: 1 }, // already A
  152: { capability: 'measure_power', scale: 1 }, // W
};

export = class WirelessRelay2Ch extends ZigBeeDevice {

  async onNodeInit() {
    this.enableDebug();
    this.printNode();

    // Relay L1 on endpoint 1 (built-in onoff system handler).
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      endpoint: 1,
      getOpts: { getOnStart: true },
      reportOpts: {
        configureAttributeReporting: { minInterval: 0, maxInterval: 3600, minChange: 0 },
      },
    });

    // Relay L2 on endpoint 2 (sub-capability needs the onOff mapping supplied).
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

    // Metering + device temperature. This older relay does not use the 0xFCC0
    // cluster; it pushes a packed struct on the Basic cluster (attribute 0xFF01)
    // using the same key/type/value layout, so the shared parser applies.
    const basic = this.zclNode.endpoints[1]?.clusters?.basic;
    if (basic) {
      basic.on(LUMI_LEGACY_ATTR_EVENT, (value: Buffer | string) => {
        try {
          this.parseLegacyReport(value);
        } catch (err) {
          this.error('Failed to parse legacy LUMI report:', err);
        }
      });
    }

    this.log('2-Channel Wireless Relay (lumi.relay.c2acn01) has been initialized');
  }

  /**
   * Decode the legacy LUMI struct (Basic cluster 0xFF01) and update the
   * metering capabilities and the device temperature.
   */
  parseLegacyReport(value: Buffer | string) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    const data = aqara.parseAqaraStruct(buffer);

    this.log('[lumi] raw hex:', buffer.toString('hex'));
    this.log('[lumi] parsed keys:', JSON.stringify(data));

    for (const [key, { capability, scale }] of Object.entries(MEASUREMENTS)) {
      const raw = data[Number(key)];
      if (raw == null || !this.hasCapability(capability)) continue;
      this.setCapabilityValue(capability, raw * scale)
        .catch((err: Error) => this.error(`Failed to set ${capability}:`, err));
    }

    const temperature = data[DEVICE_TEMPERATURE_KEY];
    if (temperature != null && this.hasCapability('measure_temperature')) {
      this.setCapabilityValue('measure_temperature', temperature)
        .catch((err: Error) => this.error('Failed to set measure_temperature:', err));
    }
  }

};
