'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import AqaraManufacturerSpecificCluster = require('../../lib/AqaraManufacturerSpecificCluster');
import aqara = require('../../lib/aqara');

// Manufacturer code used for Aqara/LUMI manufacturer-specific attributes.
const AQARA_MANUFACTURER_ID = 0x115f;

export = class SingleSwitchModuleT1 extends ZigBeeDevice {

  async onNodeInit() {
    // Verbose logging while we verify this device on real hardware.
    // enableDebug() makes homey-zigbeedriver/zigbee-clusters log all cluster
    // traffic; printNode() dumps the endpoints/clusters fingerprint.
    this.enableDebug();
    this.printNode();

    // On/off relay (genOnOff, endpoint 1).
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      endpoint: 1,
      getOpts: {
        getOnStart: true,
      },
      reportOpts: {
        configureAttributeReporting: {
          minInterval: 0,
          maxInterval: 3600,
          minChange: 0,
        },
      },
    });

    // Internal device temperature (deviceTemperature cluster, endpoint 1).
    if (this.hasCapability('measure_temperature')) {
      this.registerCapability('measure_temperature', CLUSTER.DEVICE_TEMPERATURE, {
        endpoint: 1,
        getOpts: {
          getOnStart: true,
        },
        reportOpts: {
          configureAttributeReporting: {
            minInterval: 60,
            maxInterval: 3600,
            minChange: 1,
          },
        },
      });
    }

    // Power/energy/voltage/current metering. The module does not expose the
    // standard metering clusters; it pushes these values inside the Aqara
    // manufacturer-specific "lifeline" report (cluster 0xFCC0, attribute 0xF7).
    const aqaraCluster = this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME];
    aqaraCluster.on('attr.aqaraLifeline', (value: Buffer | string) => {
      try {
        this.parseLifelineReport(value);
      } catch (err) {
        this.error('Failed to parse Aqara lifeline report:', err);
      }
    });

    // Read it once on start so the metering tiles are populated immediately.
    aqaraCluster.readAttributes(['aqaraLifeline'])
      .then((res: { aqaraLifeline?: Buffer | string }) => {
        if (res?.aqaraLifeline != null) this.parseLifelineReport(res.aqaraLifeline);
      })
      .catch((err: Error) => this.log('Initial lifeline read failed (will rely on reports):', err.message));

    // S1 input detection (modelled on the Home Assistant / zigbee-herdsman and
    // ZHA quirk implementations): the switch wired to S1 reports actuations on
    // the genMultistateInput cluster (0x0012, endpoint 41). presentValue 1 is a
    // single actuation; we flip the read-only `onoff.s1` capability on each one.
    for (const endpointId of Object.keys(this.zclNode.endpoints)) {
      const multistateInput = this.zclNode.endpoints[endpointId]?.clusters?.multistateInput;
      if (!multistateInput) continue;
      this.log(`[s1] listening on multistateInput, endpoint ${endpointId}`);
      multistateInput.on('attr.presentValue', (presentValue: number) => {
        this.handleS1Report(presentValue)
          .catch((err: Error) => this.error('Failed to handle S1 report:', err));
      });
    }

    // Apply the stored manufacturer-cluster preferences to the device.
    await this.setPowerOutageMemory(this.getSetting('power_outage_memory') ?? true)
      .catch((err: Error) => this.error('Failed to apply power_outage_memory on init:', err));
    await this.setOperationMode(this.getSetting('operation_mode') ?? 'control_relay')
      .catch((err: Error) => this.error('Failed to apply operation_mode on init:', err));
    await this.setSwitchType(this.getSetting('switch_type') ?? 'toggle')
      .catch((err: Error) => this.error('Failed to apply switch_type on init:', err));

    this.log('Single Switch Module T1 (lumi.switch.n0acn2) has been initialized');
  }

  /**
   * Handle a genMultistateInput presentValue report from the S1 input.
   * Value 1 = the switch was actuated → flip the logical S1 state. Other values
   * (0 = hold, 2 = double, …) are logged but ignored for the on/off capability.
   */
  async handleS1Report(presentValue: number) {
    this.log('[s1] presentValue =', presentValue);
    if (presentValue !== 1) return;
    await this.updateS1State(!this.getCapabilityValue('onoff.s1'));
  }

  /**
   * Update the read-only `onoff.s1` capability and fire the matching Flow
   * trigger when the state of the switch wired to terminal S1 changes.
   */
  async updateS1State(state: boolean) {
    if (!this.hasCapability('onoff.s1')) return;
    if (this.getCapabilityValue('onoff.s1') === state) return;

    await this.setCapabilityValue('onoff.s1', state);

    const triggerId = state ? 's1_turned_on' : 's1_turned_off';
    this.homey.flow.getDeviceTriggerCard(triggerId)
      .trigger(this, {}, {})
      .catch((err: Error) => this.error(`Failed to trigger ${triggerId}:`, err));
  }

  /**
   * Decode the Aqara lifeline struct and update the metering capabilities.
   */
  parseLifelineReport(value: Buffer | string) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    const data = aqara.parseAqaraStruct(buffer);

    // Log the complete report so unknown keys and scaling can be verified from
    // real device data. `raw` is the hex frame; `parsed` is every key/value.
    this.log('[lifeline] raw hex:', buffer.toString('hex'));
    this.log('[lifeline] parsed keys:', JSON.stringify(data));

    for (const [key, { capability, scale }] of Object.entries(aqara.LIFELINE_MEASUREMENTS)) {
      const raw = data[Number(key)];
      if (raw == null) {
        this.log(`[lifeline] key ${key} (${capability}) not present in this report`);
        continue;
      }
      if (!this.hasCapability(capability)) continue;

      const parsed = raw * scale;
      this.log(`[lifeline] ${capability} = ${parsed} (key ${key}, raw ${raw}, scale ${scale})`);
      this.setCapabilityValue(capability, parsed)
        .catch((err: Error) => this.error(`Failed to set ${capability}:`, err));
    }
  }

  /**
   * Write the power-outage-memory flag to the Aqara manufacturer-specific
   * cluster (0xFCC0). When enabled the relay restores its last state after a
   * power cut.
   */
  async setPowerOutageMemory(value: boolean) {
    return this.writeAqaraAttributes({ aqaraSwitchPowerOutageMemory: value });
  }

  /**
   * Set the S1 operation mode: 'decoupled' (0) reports S1 only, 'control_relay'
   * (1) lets S1 toggle the relay directly. Written to 0xFCC0 attribute 0x0200.
   */
  async setOperationMode(mode: string) {
    const value = mode === 'decoupled' ? 0 : 1;
    return this.writeAqaraAttributes({ aqaraSwitchOperationMode: value });
  }

  /**
   * Set the S1 wall-switch type: 'momentary' (2) or 'toggle' (1).
   * Written to 0xFCC0 attribute 0x000A.
   */
  async setSwitchType(type: string) {
    const value = type === 'momentary' ? 2 : 1;
    return this.writeAqaraAttributes({ aqaraSwitchType: value });
  }

  /**
   * Write one or more attributes to the Aqara manufacturer-specific cluster
   * (0xFCC0) on endpoint 1, using the LUMI manufacturer code.
   */
  async writeAqaraAttributes(attributes: { [name: string]: number | boolean }) {
    return this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME]
      .writeAttributes(attributes, { manufacturerId: AQARA_MANUFACTURER_ID });
  }

  /**
   * Handle settings changes from the Homey UI.
   */
  async onSettings({ newSettings, changedKeys }: {
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }) {
    if (changedKeys.includes('power_outage_memory')) {
      await this.setPowerOutageMemory(Boolean(newSettings.power_outage_memory));
    }
    if (changedKeys.includes('operation_mode')) {
      await this.setOperationMode(String(newSettings.operation_mode));
    }
    if (changedKeys.includes('switch_type')) {
      await this.setSwitchType(String(newSettings.switch_type));
    }
  }

};
