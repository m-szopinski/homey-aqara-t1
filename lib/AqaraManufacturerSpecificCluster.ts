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
const ATTRIBUTES = {
  // Restore the relay state after a power outage (true = remember last state).
  aqaraSwitchPowerOutageMemory: { id: 0x0201, type: ZCLDataTypes.bool },
  // Operation mode of the S1 input (0 = decoupled, 1 = controls the relay).
  aqaraSwitchOperationMode: { id: 0x0200, type: ZCLDataTypes.uint8 },
  // Wall-switch type wired to S1 (1 = toggle, 2 = momentary, 3 = none).
  aqaraSwitchType: { id: 0x000a, type: ZCLDataTypes.uint8 },
  // Interlock: prevents both relays being on at once (Dual Relay Module T2).
  aqaraInterlock: { id: 0x02d0, type: ZCLDataTypes.bool },
  // Work mode (T2): 0 = power, 1 = pulse (dry, impulse), 3 = dry.
  aqaraWorkMode: { id: 0x0289, type: ZCLDataTypes.uint8 },
  // Impulse length in ms for the T2 pulse/dry work mode (200-2000).
  aqaraPulseLength: { id: 0x00eb, type: ZCLDataTypes.uint16 },
  // "Lifeline" report: a packed struct (key/type/value tuples) the device pushes
  // periodically and on change. Carries power, energy, voltage and current. The
  // wire data type drives parsing, so the declared type here is only a fallback.
  aqaraLifeline: { id: 0x00f7, type: ZCLDataTypes.buffer },
};

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
