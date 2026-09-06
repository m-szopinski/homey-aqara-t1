'use strict';

import { ZigBeeDevice } from 'homey-zigbeedriver';
import { CLUSTER } from 'zigbee-clusters';
import AqaraManufacturerSpecificCluster = require('../../lib/AqaraManufacturerSpecificCluster');
import aqara = require('../../lib/aqara');
// Importing also registers the basic cluster extended with the legacy Aqara
// operation-mode attribute (0xFF22).
import AqaraBasicCluster = require('../../lib/AqaraBasicCluster');

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

    // Log the firmware identification so users can compare firmware revisions
    // (e.g. when checking whether an OTA update added decoupled-mode support).
    await this.zclNode.endpoints[1].clusters[AqaraBasicCluster.NAME]
      .readAttributes(['swBuildId', 'appVersion', 'dateCode'])
      .then((res: unknown) => this.log('[firmware]', JSON.stringify(res)))
      .catch((err: Error) => this.log('[firmware] read failed:', err.message));

    // Legacy decoupled-mode path (basic cluster 0xFF22) plus a readback of the
    // multistate-reporting mode (0x0009) for diagnostics.
    await this.writeLegacyOperationMode(String(this.getSetting('operation_mode') ?? 'control_relay'));
    await this.zclNode.endpoints[1].clusters[AqaraManufacturerSpecificCluster.NAME]
      .readAttributes(['aqaraMode'])
      .then((res: unknown) => this.log('[settings] aqaraMode (0x0009) readback:', JSON.stringify(res)))
      .catch((err: Error) => this.log('[settings] aqaraMode (0x0009) read failed:', err.message));

    // Diagnostic: list the attributes the 0xFCC0 cluster exposes. Decoupled
    // mode works when this module is configured by an Aqara hub, so the hub
    // may be using an additional, undocumented attribute — discovering the
    // attribute list on a hub-configured module lets us diff against one
    // configured by Homey.
    await aqaraCluster.discoverAttributesExtended()
      .then((attrs: unknown) => this.log('[diag] 0xFCC0 attributes (extended):', JSON.stringify(attrs)))
      .catch(() => aqaraCluster.discoverAttributes()
        .then((attrs: unknown) => this.log('[diag] 0xFCC0 attributes:', JSON.stringify(attrs)))
        .catch((err: Error) => this.log('[diag] attribute discovery failed:', err.message)));

    // One-time: put the module in the mode that reports S1 actuations on the
    // multistateInput cluster. Without this write the device stays silent in
    // decoupled mode (zigbee-herdsman-converters does the same in its
    // `configure` step for lumi.switch.n0acn2). The write makes the module
    // restart its Zigbee application (an end-device announce follows a few
    // seconds later), so it runs once per paired device and after the
    // settings write; it is fire-and-forget because the device does not
    // reliably send a Write Attributes Response for this attribute.
    if (this.getStoreValue('aqara_multistate_mode_set') !== true) {
      await this.writeAqaraAttributes({ aqaraMode: 1 }, { waitForResponse: false })
        .then(() => this.setStoreValue('aqara_multistate_mode_set', true))
        .catch((err: Error) => this.log('Failed to enable multistate reporting mode (S1 events may not report):', err.message));
    }

    this.log('Single Switch Module T1 (lumi.switch.n0acn2) has been initialized');
  }

  /**
   * Read the operation mode back from the device and compare with what was
   * written. A Write Attributes Response with a failure status is not raised
   * as an error by zigbee-clusters, so a rejected write would otherwise look
   * like a success; the readback catches that. Neither Zigbee2MQTT nor ZHA
   * expose decoupled mode for this module (open upstream feature request), so
   * the firmware may simply not implement attribute 0x0200.
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
   * Set the S1 operation mode: 'decoupled' reports S1 only, 'control_relay'
   * lets S1 toggle the relay directly. Written through both known Aqara
   * mechanisms: 0xFCC0 attribute 0x0200 (0 = decoupled, 1 = control relay,
   * newer generation) and basic-cluster attribute 0xFF22 (0xFE = decoupled,
   * 0x12 = control relay, older generation) — the T1 module stores 0x0200 but
   * has been seen to not act on it, so the legacy attribute is tried as well.
   */
  async setOperationMode(mode: string) {
    const value = mode === 'decoupled' ? 0 : 1;
    await this.writeAqaraAttributes({ aqaraSwitchOperationMode: value });
    await this.writeLegacyOperationMode(mode);
  }

  /**
   * Write the legacy basic-cluster operation mode (0xFF22) and log the
   * readback. Best-effort: firmware that does not implement the attribute
   * only logs a failure.
   */
  async writeLegacyOperationMode(mode: string) {
    const basicCluster = this.zclNode.endpoints[1].clusters[AqaraBasicCluster.NAME];
    if (!basicCluster) return;
    const value = mode === 'decoupled' ? 0xfe : 0x12;
    try {
      await basicCluster.writeAttributes({ aqaraOperationMode: value });
      const readback = await basicCluster.readAttributes(['aqaraOperationMode']);
      this.log('[settings] legacy operation mode (0xFF22) readback:', JSON.stringify(readback));
    } catch (err) {
      this.log('[settings] legacy operation mode (0xFF22) not accepted:', (err as Error).message);
    }
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
   * (0xFCC0) on endpoint 1. The LUMI manufacturer code (0x115F) is applied by
   * zigbee-clusters from the attribute definitions.
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
