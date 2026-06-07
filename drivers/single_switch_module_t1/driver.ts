'use strict';

import { ZigBeeDriver } from 'homey-zigbeedriver';

export = class SingleSwitchModuleT1Driver extends ZigBeeDriver {

  async onInit() {
    this.log('SingleSwitchModuleT1Driver has been initialized');
  }

};
