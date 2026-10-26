# Changelog

All notable changes to Hobeian are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Historical entries are reconstructed from `.homeychangelog.json` and the previous readme. Dates use GitHub release dates where available; versions without a GitHub release use the date recorded in Git history. These dates do not indicate Homey Live certification dates.

## [Unreleased]

## [1.0.11] - 2026-10-26

### Added

- Copyable/downloadable soil sensor diagnostics in the app settings, with an authenticated read-only API.
- Retained settings requests, attempts, failures and sensor readbacks, plus per-datapoint report/change counts and timing across restarts.
- Passive observations of native temperature/humidity clusters, unknown Tuya datapoints, bounded raw payloads and Homey capability update failures.

### Changed

- Replace repetitive soil sensor frame/value logging with a compact diagnostic summary every two minutes. Measurement snapshots are checkpointed at that interval; settings events are saved immediately.

## [1.0.10] - 2026-10-26

### Fixed

- AY-303Z and ZG-303Z user settings retain failed writes for the next wake, survive app restarts, and preserve edits made while a previous value is being sent.
- Settings changes send only the edited values, avoiding a full configuration rewrite during a short wake window.

### Added

- Diagnostic logs distinguish requested settings, sent commands, and matching or mismatching settings reported by the sensor.
- Dedicated release history in CHANGELOG.md.

### Changed

- Introduce the app, supported sensors, pairing, and Homey Flow examples in the readmes.
- Move device settings, technical details, hardware testing notes, and release instructions to separate development documentation.
- Replace ZG-222Z and ZG-227Z driver illustrations with model-specific product photos on transparent backgrounds; photo reuse permission remains to be confirmed before release.

## [1.0.9] - 2026-10-19

### Changed

- Remove the experimental label from AY-303Z support after successful testing on three units.
- Refresh the app artwork and listing description to reflect supported Hobeian Zigbee sensors.

## [1.0.8] - 2026-10-17

### Added

- ZG-204ZX presence, illuminance, temperature, humidity, and battery support.
- Credit the ZG-204ZX contribution in the app's developer metadata.

### Fixed

- Tuya settings encoding and ZG-204ZX first-pair initialization.
- Retry ZG-204ZX settings after failed writes and retain pending changes across app restarts and concurrent edits.
- Keep AY-303Z dry-soil alarms controlled by the sensor.

## [1.0.7] - 2026-10-12

### Added

- Experimental AOYAN AY-303Z soil sensor support with device-specific dry-soil alarm and temperature-unit handling.

## [1.0.6] - 2026-03-17

### Added

- ZG-222Z water leak sensor support.

## [1.0.5] - 2026-03-17

### Added

- Experimental ZG-227Z temperature and humidity sensor support.

## [1.0.4] - 2025-12-29

### Changed

- Update the app description.

## [1.0.3] - 2025-12-28

### Changed

- Update app metadata.

## [1.0.2] - 2025-12-28

### Changed

- Update app metadata.

## [1.0.1] - 2025-12-28

### Added

- App images for publishing.

## [1.0.0] - 2025-12-28

### Added

- Initial ZG-303Z soil sensor support with soil moisture, temperature, humidity, battery level, and water shortage alarm.

[Unreleased]: https://github.com/elrond1999/com.hobeian/compare/v1.0.11...HEAD
[1.0.11]: https://github.com/elrond1999/com.hobeian/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/elrond1999/com.hobeian/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/elrond1999/com.hobeian/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/elrond1999/com.hobeian/compare/f6b925c...v1.0.8
[1.0.7]: https://github.com/elrond1999/com.hobeian/compare/v1.0.6...f6b925c
[1.0.6]: https://github.com/elrond1999/com.hobeian/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/elrond1999/com.hobeian/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/elrond1999/com.hobeian/compare/301fa67...v1.0.4
[1.0.3]: https://github.com/elrond1999/com.hobeian/compare/a074af4...301fa67
[1.0.2]: https://github.com/elrond1999/com.hobeian/compare/da59e21...a074af4
[1.0.1]: https://github.com/elrond1999/com.hobeian/compare/8e9e072...da59e21
[1.0.0]: https://github.com/elrond1999/com.hobeian/tree/8e9e072
