'use strict';

import { ZigBeeDriver } from 'homey-zigbeedriver';

export = class DualRelayModuleT2Driver extends ZigBeeDriver {

  async onInit() {
    this.log('DualRelayModuleT2Driver has been initialized');
  }

};
