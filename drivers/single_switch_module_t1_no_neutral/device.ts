'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import AqaraManufacturerSpecificCluster = require('../../lib/AqaraManufacturerSpecificCluster');
import aqara = require('../../lib/aqara');

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

    // Apply the stored manufacturer-cluster preferences in one write (all
    // three attributes live on the same cluster). Right after an app restart
    // the module may still be re-announcing itself, so the write is retried.
    await aqara.retry(() => this.writeAqaraAttributes({
      aqaraSwitchPowerOutageMemory: Boolean(this.getSetting('power_outage_memory') ?? true),
      aqaraSwitchOperationMode: (this.getSetting('operation_mode') ?? 'control_relay') === 'decoupled' ? 0 : 1,
      aqaraSwitchType: (this.getSetting('switch_type') ?? 'toggle') === 'momentary' ? 2 : 1,
    }), (...args) => this.log('[settings]', ...args))
      .then(() => this.verifyOperationMode(String(this.getSetting('operation_mode') ?? 'control_relay')))
      .catch((err: Error) => this.error('Failed to apply settings on init:', err));

    // One-time: put the module in the mode that reports S1 actuations on the
    // multistateInput cluster (required for decoupled mode; mirrors the
    // zigbee-herdsman-converters `configure` step for the T1 modules). The
    // write makes the module restart its Zigbee application (an end-device
    // announce follows a few seconds later), so it runs once per paired
    // device and after the settings write; it is fire-and-forget because the
    // device does not reliably send a Write Attributes Response for it.
    if (this.getStoreValue('aqara_multistate_mode_set') !== true) {
      await this.writeAqaraAttributes({ aqaraMode: 1 }, { waitForResponse: false })
        .then(() => this.setStoreValue('aqara_multistate_mode_set', true))
        .catch((err: Error) => this.log('Failed to enable multistate reporting mode (S1 events may not report):', err.message));
    }

    this.log('Single Switch Module T1 No Neutral (lumi.switch.l0agl1) has been initialized');
  }

  /**
   * Read the operation mode back from the device and compare with what was
   * written. A Write Attributes Response with a failure status is not raised
   * as an error by zigbee-clusters, so a rejected write would otherwise look
   * like a success; the readback catches that. Neither Zigbee2MQTT nor ZHA
   * expose decoupled mode for this module, so the firmware may simply not
   * implement attribute 0x0200.
   */
  async verifyOperationMode(mode: string) {
    const expected = mode === 'decoupled' ? 0 : 1;
    const result = await this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME]
      .readAttributes(['aqaraSwitchOperationMode']);
    this.log('[settings] operation mode readback:', JSON.stringify(result));
    if (result?.aqaraSwitchOperationMode !== expected) {
      throw new Error(`The device did not accept the S1 operation mode (expected ${expected}, `
        + `device reports ${result?.aqaraSwitchOperationMode ?? 'nothing'}). `
        + 'The firmware of this module may not support decoupled mode.');
    }
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
  async writeAqaraAttributes(
    attributes: { [name: string]: number | boolean },
    opts?: { waitForResponse?: boolean },
  ) {
    return this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME]
      .writeAttributes(attributes, opts);
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
      // Surface a rejected write to the user instead of silently pretending
      // the mode changed (throwing here makes Homey show the error).
      await this.verifyOperationMode(String(newSettings.operation_mode));
    }
    if (changedKeys.includes('switch_type')) {
      await this.setSwitchType(String(newSettings.switch_type));
    }
  }

};
