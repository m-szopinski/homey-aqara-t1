'use strict';

import { ZigBeeDriver } from 'homey-zigbeedriver';

export = class WirelessRelay2ChDriver extends ZigBeeDriver {

  async onInit() {
    this.log('WirelessRelay2ChDriver has been initialized');
  }

};
