'use strict';

/**
 * Shared helpers for decoding Aqara/LUMI manufacturer-specific data.
 *
 * The metering on the T1/T2 modules is not exposed through the standard Zigbee
 * metering clusters; the device pushes it inside a packed "lifeline" struct
 * (manufacturer cluster 0xFCC0, attribute 0x00F7). The struct is a flat
 * sequence of `[key:uint8][zclType:uint8][value...]` tuples.
 */

// Keys inside the lifeline struct that carry electrical measurements, with the
// Homey capability and scaling they map to. Mapping follows the Zigbee2MQTT /
// zigbee-herdsman-converters definitions for these LUMI switch/relay modules.
const LIFELINE_MEASUREMENTS: {
  [key: number]: { capability: string; scale: number };
} = {
  149: { capability: 'meter_power', scale: 1 }, // energy, kWh
  150: { capability: 'measure_voltage', scale: 0.1 }, // 0.1 V
  151: { capability: 'measure_current', scale: 0.001 }, // mA -> A
  152: { capability: 'measure_power', scale: 1 }, // W
};

/**
 * Decode an Aqara/Xiaomi packed struct buffer into a `{ key: value }` map.
 * The ZCL data type byte after each key determines how many bytes the value
 * spans, so we can walk the buffer without knowing the keys in advance.
 */
function parseAqaraStructFrom(buffer: Buffer, start: number): { [key: number]: number } {
  const result: { [key: number]: number } = {};
  let i = start;

  while (i + 2 <= buffer.length) {
    const key = buffer.readUInt8(i);
    const type = buffer.readUInt8(i + 1);
    i += 2;

    switch (type) {
      case 0x10: // bool
      case 0x20: // uint8
      case 0x08: // data8
      case 0x18: // map8
      case 0x30: // enum8
        result[key] = buffer.readUInt8(i); i += 1; break;
      case 0x28: // int8
        result[key] = buffer.readInt8(i); i += 1; break;
      case 0x21: // uint16
      case 0x09: // data16
      case 0x19: // map16
      case 0x31: // enum16
        result[key] = buffer.readUInt16LE(i); i += 2; break;
      case 0x29: // int16
        result[key] = buffer.readInt16LE(i); i += 2; break;
      case 0x22: // uint24
        result[key] = buffer.readUIntLE(i, 3); i += 3; break;
      case 0x2a: // int24
        result[key] = buffer.readIntLE(i, 3); i += 3; break;
      case 0x23: // uint32
      case 0x0b: // data32
        result[key] = buffer.readUInt32LE(i); i += 4; break;
      case 0x2b: // int32
        result[key] = buffer.readInt32LE(i); i += 4; break;
      case 0x24: // uint40
        result[key] = buffer.readUIntLE(i, 5); i += 5; break;
      case 0x25: // uint48
        result[key] = buffer.readUIntLE(i, 6); i += 6; break;
      case 0x27: // uint64
        result[key] = Number(buffer.readBigUInt64LE(i)); i += 8; break;
      case 0x2f: // int64
        result[key] = Number(buffer.readBigInt64LE(i)); i += 8; break;
      case 0x39: // single float
        result[key] = buffer.readFloatLE(i); i += 4; break;
      case 0x3a: // double float
        result[key] = buffer.readDoubleLE(i); i += 8; break;
      case 0x41: // octet string
      case 0x42: { // character string
        const len = buffer.readUInt8(i); i += 1 + len; break;
      }
      default:
        // Unknown type: we can no longer know the value length, so stop to
        // avoid misaligned reads on the rest of the buffer.
        return result;
    }
  }

  return result;
}

function parseAqaraStruct(buffer: Buffer): { [key: number]: number } {
  const result = parseAqaraStructFrom(buffer, 0);

  // The lifeline value can arrive as a raw ZCL octet-string payload, which
  // still carries its length prefix (first byte = number of bytes that
  // follow). In that case parsing from offset 0 hits an unknown type byte and
  // yields nothing; retry after the prefix.
  if (Object.keys(result).length === 0
    && buffer.length > 1
    && buffer.readUInt8(0) === buffer.length - 1) {
    return parseAqaraStructFrom(buffer, 1);
  }

  return result;
}

/**
 * Run an async Zigbee operation with retries. Right after an app (re)start a
 * module can still be re-announcing itself on the network, so a first write
 * can time out; a short pause and another attempt usually succeeds.
 */
async function retry<T>(
  fn: () => Promise<T>,
  log: (...args: unknown[]) => void,
  attempts = 3,
  delayMs = 3000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      log(`Attempt ${attempt}/${attempts} failed (${(err as Error).message}); retrying in ${delayMs} ms`);
      // The timer is short-lived (a few seconds during init) and resolves the
      // promise itself, so it does not need to be cleared on app destroy.
      // eslint-disable-next-line no-await-in-loop, homey-app/global-timers
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export = { LIFELINE_MEASUREMENTS, parseAqaraStruct, retry };
