'use strict';

import { ZigBeeDriver } from 'homey-zigbeedriver';

export = class SingleSwitchModuleT1NoNeutralDriver extends ZigBeeDriver {

  async onInit() {
    this.log('SingleSwitchModuleT1NoNeutralDriver has been initialized');
  }

};
