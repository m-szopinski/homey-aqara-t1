'use strict';

import { Cluster, ZCLDataTypes } from 'zigbee-clusters';

/**
 * Aqara / Xiaomi (LUMI) manufacturer-specific cluster (0xFCC0).
 *
 * Used by the Single Switch Module T1 (lumi.switch.n0acn2) to expose
 * configuration such as the power-outage memory (relay state restore after a
 * power cut) and the switch operation mode. The manufacturer code for these
 * attributes is 0x115F (4447).
 *
 * Only the attributes we actually use are declared here; the device exposes
 * more, but declaring them is not required to read/write the ones we need.
 */
// LUMI manufacturer code. Declaring it per attribute makes zigbee-clusters set
// the manufacturer-specific flag on read/write frames; the devices reject
// writes to these attributes without it (zigbee-herdsman-converters passes
// `manufacturerCode: 0x115f` on every manuSpecificLumi command for the same
// reason).
const AQARA_MANUFACTURER_ID = 0x115f;

const ATTRIBUTES = {
  // Device mode: writing 1 makes the module report S1/S2 actuations on the
  // multistateInput cluster (required for decoupled mode; mirrors the
  // zigbee-herdsman-converters `configure` step for lumi.switch.n0acn2).
  aqaraMode: { id: 0x0009, type: ZCLDataTypes.uint8, manufacturerId: AQARA_MANUFACTURER_ID },
  // Restore the relay state after a power outage (true = remember last state).
  aqaraSwitchPowerOutageMemory: { id: 0x0201, type: ZCLDataTypes.bool, manufacturerId: AQARA_MANUFACTURER_ID },
  // Operation mode of the S1 input (0 = decoupled, 1 = controls the relay).
  aqaraSwitchOperationMode: { id: 0x0200, type: ZCLDataTypes.uint8, manufacturerId: AQARA_MANUFACTURER_ID },
  // Wall-switch type wired to S1 (1 = toggle, 2 = momentary, 3 = none).
  aqaraSwitchType: { id: 0x000a, type: ZCLDataTypes.uint8, manufacturerId: AQARA_MANUFACTURER_ID },
  // Interlock: prevents both relays being on at once (Dual Relay Module T2).
  aqaraInterlock: { id: 0x02d0, type: ZCLDataTypes.bool, manufacturerId: AQARA_MANUFACTURER_ID },
  // Work mode (T2): 0 = power, 1 = pulse (dry, impulse), 3 = dry.
  aqaraWorkMode: { id: 0x0289, type: ZCLDataTypes.uint8, manufacturerId: AQARA_MANUFACTURER_ID },
  // Impulse length in ms for the T2 pulse/dry work mode (200-2000).
  aqaraPulseLength: { id: 0x00eb, type: ZCLDataTypes.uint16, manufacturerId: AQARA_MANUFACTURER_ID },
  // "Lifeline" report: a packed struct (key/type/value tuples) the device pushes
  // periodically and on change. Carries power, energy, voltage and current. The
  // wire data type drives parsing, so the declared type here is only a fallback.
  aqaraLifeline: { id: 0x00f7, type: ZCLDataTypes.buffer, manufacturerId: AQARA_MANUFACTURER_ID },
};

// Diagnostic scan attributes: candidate manufacturer-specific ids seen across
// Aqara devices in zigbee-herdsman-converters, ZHA quirks and the SmartThings
// Edge driver. Declared only so readAttributes() sends them with the LUMI
// manufacturer code; used to dump which ids a firmware actually exposes.
const SCAN_ATTRIBUTE_IDS = [
  0x0125, 0x0126, 0x0127, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207,
  0x0208, 0x0209, 0x020a, 0x020b, 0x020c, 0x020d, 0x020e, 0x020f, 0x0210,
  0x0211, 0x0212, 0x0213, 0x0214, 0x0215, 0x0285, 0x0286, 0x028b, 0x0505,
  0x0517,
];
const attributes = ATTRIBUTES as {
  [name: string]: { id: number; type: unknown; manufacturerId: number };
};
for (const id of SCAN_ATTRIBUTE_IDS) {
  attributes[`aqaraScan0x${id.toString(16).padStart(4, '0')}`] = {
    id,
    type: ZCLDataTypes.uint8,
    manufacturerId: 0x115f,
  };
}

const COMMANDS = {};

class AqaraManufacturerSpecificCluster extends Cluster {

  static get ID() {
    return 0xfcc0;
  }

  static get NAME() {
    return 'aqaraManufacturerSpecific';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return COMMANDS;
  }

}

Cluster.addCluster(AqaraManufacturerSpecificCluster);

export = AqaraManufacturerSpecificCluster;
