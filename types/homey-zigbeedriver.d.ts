/* eslint-disable */
declare module 'homey-zigbeedriver' {
  import Homey from 'homey';

  /**
   * Minimal ambient declarations for homey-zigbeedriver (the package ships no
   * types). Only the surface this app uses is declared.
   */
  export class ZigBeeDevice extends Homey.Device {
    zclNode: any;
    enableDebug(): void;
    printNode(): void;
    registerCapability(
      capabilityId: string,
      cluster: any,
      clusterCapabilityConfiguration?: any,
    ): void;
    configureAttributeReporting(configurations: any[]): Promise<void>;
    onNodeInit(args: { zclNode: any; node?: any }): Promise<void> | void;
  }

  export class ZigBeeDriver extends Homey.Driver {}

  export class ZigBeeLightDevice extends ZigBeeDevice {}

  export const Util: any;
}
