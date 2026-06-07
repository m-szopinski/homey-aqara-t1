# Aqara T1

A [Homey](https://homey.app) app that adds local Zigbee support for **Aqara relay / switch modules** (T1, T2 and the older 2-channel wireless relay) — no Aqara hub required.

## Supported devices

| Device | Driver | Zigbee model(s) | Channels | Metering |
| --- | --- | --- | :---: | :---: |
| Single Switch Module T1 (with Neutral) | `single_switch_module_t1` | `lumi.switch.n0acn2`, `lumi.switch.n0agl1` | 1 | ✅ |
| Single Switch Module T1 (No Neutral) | `single_switch_module_t1_no_neutral` | `lumi.switch.l0agl1`, `lumi.switch.l0acn1` | 1 | — |
| Dual Relay Module T2 | `dual_relay_module_t2` | `lumi.switch.acn047` | 2 | ✅ |
| 2-Channel Wireless Relay | `wireless_relay_2ch` | `lumi.relay.c2acn01` | 2 | ✅ |

> Model codes: with-neutral T1 = **DLKZMK11LM** / SSM-U01; no-neutral T1 = **SSM-U02**; T2 = **LLKZMK12LM** / DCM-K01; older 2-channel relay = **LLKZMK11LM**. All report `LUMI` / `Aqara` as the manufacturer. The no-neutral T1 has no power metering (hardware limitation).

## Capabilities

| Capability | T1 neutral | T1 no-neutral | T2 | Relay 2-ch |
| --- | :---: | :---: | :---: | :---: |
| `onoff` — relay (L1) | ✅ | ✅ | ✅ | ✅ |
| `onoff.l2` — relay L2 | — | — | ✅ | ✅ |
| `onoff.s1` / `onoff.s2` — wired switch input (read-only) | ✅ (S1) | — | ✅ | — |
| `measure_power` / `meter_power` / `measure_voltage` / `measure_current` | ✅ | — | ✅ | ✅ |
| `measure_temperature` — internal temperature | ✅ | ✅ | ✅ | ✅ |

Relays use the standard `genOnOff` cluster (`0x0006`). Sub-capabilities (`onoff.l2`,
`onoff.s1`, `onoff.s2`) are mapped to the relevant endpoint.

### Metering

These modules do **not** expose the standard Zigbee metering clusters. Power /
energy / voltage / current are decoded from an Aqara packed struct:

- **T1 / T2** — the manufacturer cluster `0xFCC0`, attribute `0x00F7` ("lifeline").
- **2-Channel Wireless Relay (LLKZMK11LM)** — the legacy struct on the Basic
  cluster (`0x0000`), attribute `0xFF01`.

Both use the same key/type/value layout, decoded by the shared parser in
[`lib/aqara.ts`](lib/aqara.ts). Key mapping and per-model scaling follow the
[zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters)
/ Zigbee2MQTT definitions, including the model-specific differences:

| Struct key | Default | T2 (LLKZMK12LM) | Relay 2-ch (LLKZMK11LM) |
| --- | --- | --- | --- |
| 149 energy | value (kWh) | value ÷ 1000 | value (kWh) |
| 150 voltage | value × 0.1 | value × 0.1 | value × 0.1 |
| 151 current | value × 0.001 | value × 0.001 | value (already A) |
| 152 power | value (W) | value (W) | value (W) |

### S1 / S2 inputs

The switches wired to the S1/S2 terminals are exposed as read-only `onoff.s1` /
`onoff.s2` capabilities, plus Flow trigger cards ("S1/S2 input turned on/off").
Each actuation reported on the `genMultistateInput` cluster flips the logical
state. Set the input mode to **Decoupled** (see settings) to use the switch in
Flows independently of the relay.

## Settings

| Setting | Devices | Aqara attribute (`0xFCC0`) |
| --- | --- | --- |
| Power-outage memory | T1, T2 | `0x0201` |
| S1/S2 input mode (control relay / decoupled) | T1, T2 (per channel) | `0x0200` `{decoupled:0, control_relay:1}` |
| Switch type (toggle / momentary) | T1, T2 | `0x000A` `{toggle:1, momentary:2}` |
| Interlock (prevent both relays on) | T2 | `0x02D0` |
| Work mode (power / pulse / dry) | T2 | `0x0289` `{power:0, pulse:1, dry:3}` |

Attribute ids and value mappings are taken from the Home Assistant
(zigbee-herdsman-converters / zha-device-handlers) implementations.

## Pairing

1. In Homey, add a device and pick the matching driver.
2. Press and hold the module's button (or the connected wall switch) for at
   least 5 seconds, until the indicator flashes blue.
3. Release the button — the module is now in pairing mode and Homey will find it.

Modules wired with neutral act as Zigbee routers; the no-neutral T1 joins as an
end device.

## Development

This is a TypeScript Homey app built with
[`homey-zigbeedriver`](https://www.npmjs.com/package/homey-zigbeedriver) and
[`zigbee-clusters`](https://www.npmjs.com/package/zigbee-clusters).

```bash
npm install          # install dependencies
npm run build        # type-check (tsc)
npm run lint         # eslint
homey app validate   # validate the app manifest (--level verified)
homey app run        # run on a connected Homey with live logs
```

CI validates the app on every push (`.github/workflows/homey-app-validate.yml`);
it runs `npm ci` before the validator so the TypeScript can compile.

### Project layout

```
.homeycompose/app.json                       app manifest base (id, name, images…)
.homeycompose/flow/triggers/                 S1/S2 Flow trigger cards
lib/AqaraManufacturerSpecificCluster.ts      Aqara 0xFCC0 cluster definition
lib/aqara.ts                                 shared packed-struct parser + key map
drivers/single_switch_module_t1/             T1 with-neutral (relay + S1 + metering)
drivers/single_switch_module_t1_no_neutral/  T1 no-neutral (relay only)
drivers/dual_relay_module_t2/                T2 dual relay (2× relay + S1/S2 + metering)
drivers/wireless_relay_2ch/                  LLKZMK11LM (2× relay + legacy metering)
types/homey-zigbeedriver.d.ts                ambient types for homey-zigbeedriver
```

Driver manifests live in each driver's `driver.compose.json`; Homey merges them
into the generated `app.json` at build/validate time — edit the compose files,
not `app.json` directly.

## Status & known limitations

Only the T1 (with neutral) has been verified on real hardware. The other drivers
are modelled on the Home Assistant implementations; the protocol details below
were taken from the zigbee-herdsman-converters source, but the end-to-end
behaviour still needs confirmation on real devices:

- **Metering scaling** is now applied per model (see the table above) — the T2
  energy is ÷1000 and the LLKZMK11LM current is unscaled. Each report is still
  logged (`[lifeline] …` / `[lumi] …`) so the values can be sanity-checked.
- **Fingerprints / endpoints** for T2 and the 2-channel relay come from the
  device interviews in Zigbee2MQTT / ZHA; check `printNode()` output after pairing.
- **S1/S2 inputs** are read from `genMultistateInput` (`presentValue === 1` =
  actuation), matching the HA implementation. The S1/S2 ↔ L1/L2 mapping on T2
  assumes ascending endpoint order.
- **Interlock / power-outage memory on LLKZMK11LM** use the legacy scheme
  (interlock → `genBinaryOutput` attribute `0xFF06`; power-outage memory →
  `genBasic` `0xFFF0` raw payload) and are not implemented yet.
- Verbose debug logging (`enableDebug()`) is on and should be removed before a
  public release.
- Device images are official product renders; replace them before publishing to
  the Homey App Store if you need redistribution rights.

## Credits

- Device details, attribute ids and metering mapping derived from
  [Zigbee2MQTT / zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters),
  [zha-device-handlers](https://github.com/zigpy/zha-device-handlers) and
  [blakadder's Zigbee database](https://zigbee.blakadder.com/).
- Built on Athom's [Homey Apps SDK v3](https://apps.developer.homey.app/).

## License

See [LICENSE](LICENSE).
