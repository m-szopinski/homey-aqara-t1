'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import AqaraManufacturerSpecificCluster = require('../../lib/AqaraManufacturerSpecificCluster');

export = class SingleSwitchModuleT1NoNeutral extends ZigBeeDevice {

  async onNodeInit() {
    // Verbose logging while we verify this device on real hardware.
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
    // The no-neutral module exposes device temperature but NOT power metering,
    // so there are no measure_power/meter_power/voltage/current capabilities.
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

    // S1 input detection (HA: genMultistateInput, presentValue === 1 = actuation).
    for (const endpointId of Object.keys(this.zclNode.endpoints)) {
      const multistateInput = this.zclNode.endpoints[endpointId]?.clusters?.multistateInput;
      if (!multistateInput) continue;
      this.log(`[s1] listening on multistateInput, endpoint ${endpointId}`);
      multistateInput.on('attr.presentValue', (presentValue: number) => {
        this.handleS1Report(presentValue)
          .catch((err: Error) => this.error('Failed to handle S1 report:', err));
      });
    }

    // Put the module in the mode that reports S1 actuations on the
    // multistateInput cluster (required for decoupled mode; mirrors the
    // zigbee-herdsman-converters `configure` step for the T1 modules). Not all
    // firmware variants support the attribute, so a failure is only logged.
    await this.writeAqaraAttributes({ aqaraMode: 1 })
      .catch((err: Error) => this.log('Failed to enable multistate reporting mode (S1 events may not report):', err.message));

    // Apply the stored manufacturer-cluster preferences to the device.
    await this.setPowerOutageMemory(this.getSetting('power_outage_memory') ?? true)
      .catch((err: Error) => this.error('Failed to apply power_outage_memory on init:', err));
    await this.setOperationMode(this.getSetting('operation_mode') ?? 'control_relay')
      .catch((err: Error) => this.error('Failed to apply operation_mode on init:', err));
    await this.setSwitchType(this.getSetting('switch_type') ?? 'toggle')
      .catch((err: Error) => this.error('Failed to apply switch_type on init:', err));

    this.log('Single Switch Module T1 No Neutral (lumi.switch.l0agl1) has been initialized');
  }

  /**
   * Handle a genMultistateInput presentValue report from the S1 input.
   * Value 1 = actuation → flip the logical S1 state and fire the Flow trigger.
   */
  async handleS1Report(presentValue: number) {
    this.log('[s1] presentValue =', presentValue);
    if (presentValue !== 1) return;
    await this.updateS1State(!this.getCapabilityValue('onoff.s1'));
  }

  /**
   * Update the read-only `onoff.s1` capability and fire the matching Flow trigger.
   */
  async updateS1State(state: boolean) {
    if (!this.hasCapability('onoff.s1')) return;
    if (this.getCapabilityValue('onoff.s1') === state) return;

    await this.setCapabilityValue('onoff.s1', state);

    const triggerId = state ? 'nn_s1_turned_on' : 'nn_s1_turned_off';
    this.homey.flow.getDeviceTriggerCard(triggerId)
      .trigger(this, {}, {})
      .catch((err: Error) => this.error(`Failed to trigger ${triggerId}:`, err));
  }

  /**
   * Write the power-outage-memory flag (0xFCC0, attribute 0x0201).
   */
  async setPowerOutageMemory(value: boolean) {
    return this.writeAqaraAttributes({ aqaraSwitchPowerOutageMemory: value });
  }

  /**
   * Set the S1 operation mode: 'decoupled' (0) reports S1 only, 'control_relay'
   * (1) lets S1 toggle the relay directly. 0xFCC0 attribute 0x0200.
   */
  async setOperationMode(mode: string) {
    return this.writeAqaraAttributes({ aqaraSwitchOperationMode: mode === 'decoupled' ? 0 : 1 });
  }

  /**
   * Set the S1 wall-switch type: 'momentary' (2) or 'toggle' (1). 0xFCC0 0x000A.
   */
  async setSwitchType(type: string) {
    return this.writeAqaraAttributes({ aqaraSwitchType: type === 'momentary' ? 2 : 1 });
  }

  /**
   * Write attributes to the Aqara manufacturer cluster (0xFCC0) on endpoint 1.
   * The LUMI manufacturer code (0x115F) is applied by zigbee-clusters from the
   * attribute definitions.
   */
  async writeAqaraAttributes(attributes: { [name: string]: number | boolean }) {
    return this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME]
      .writeAttributes(attributes);
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
