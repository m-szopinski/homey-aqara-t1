'use strict';

import { BasicCluster, Cluster, ZCLDataTypes } from 'zigbee-clusters';

const AQARA_MANUFACTURER_ID = 0x115f;

/**
 * Basic cluster extended with the Aqara/Xiaomi legacy operation-mode
 * attribute. Older-generation Aqara relays and wall switches implement
 * decoupled mode through basic-cluster attribute 0xFF22 (0x12 = control the
 * relay, 0xFE = decoupled; see `xiaomi_switch_operation_mode_basic` in
 * zigbee-herdsman-converters) rather than 0xFCC0/0x0200. Registering this
 * class replaces the stock basic cluster for all drivers in the app, which is
 * harmless: it only adds an attribute definition.
 */
class AqaraBasicCluster extends BasicCluster {

  static get ATTRIBUTES() {
    return Object.assign({}, super.ATTRIBUTES, {
      aqaraOperationMode: { id: 0xff22, type: ZCLDataTypes.uint8, manufacturerId: AQARA_MANUFACTURER_ID },
    });
  }

}

Cluster.addCluster(AqaraBasicCluster);

export = AqaraBasicCluster;
