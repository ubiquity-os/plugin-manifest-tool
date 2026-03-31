# Changelog

## [1.3.0](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.2.2...v1.3.0) (2026-03-31)


### Features

* add Deno deploy manifest awareness ([b29a661](https://github.com/ubiquity-os/plugin-manifest-tool/commit/b29a6616bf78b18c3e634aaafe218e020aab499e))
* detect Deno deploy manifest context ([adc064e](https://github.com/ubiquity-os/plugin-manifest-tool/commit/adc064e81e579010961b3aa2038ba64bf8e54b90))


### Bug Fixes

* tighten Deno config resolution ([27cdeae](https://github.com/ubiquity-os/plugin-manifest-tool/commit/27cdeae50265ef81135e25e6974ec4ecb0840115))
* use deno deploy metadata for repository ([fa258bd](https://github.com/ubiquity-os/plugin-manifest-tool/commit/fa258bd35c3e23b2c596c4b6baa8f34324c945a2))

## [1.2.2](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.2.1...v1.2.2) (2026-03-10)


### Bug Fixes

* **manifest:** remove webhook-name listener validation ([3cc88dd](https://github.com/ubiquity-os/plugin-manifest-tool/commit/3cc88dde3f49cf032d6a8e9f01958011fcf8e74e))

## [1.2.1](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.2.0...v1.2.1) (2026-03-10)


### Bug Fixes

* accept dotless webhook listeners ([2faec3b](https://github.com/ubiquity-os/plugin-manifest-tool/commit/2faec3b6d264470e4641050df748d5481fa5ff15))

## [1.2.0](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.1.1...v1.2.0) (2026-03-05)


### Features

* **manifest:** auto-detect repository and ref defaults ([#9](https://github.com/ubiquity-os/plugin-manifest-tool/issues/9)) ([200a006](https://github.com/ubiquity-os/plugin-manifest-tool/commit/200a00654ac38110ac2a90fa5fdd24bd209a3e3d))


### Bug Fixes

* **manifest:** convert single-object command schemas ([#10](https://github.com/ubiquity-os/plugin-manifest-tool/issues/10)) ([8a1d5e7](https://github.com/ubiquity-os/plugin-manifest-tool/commit/8a1d5e73453d9199a6593e47c1030d0f14ea2d7a))

## [1.1.1](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.1.0...v1.1.1) (2026-02-24)


### Bug Fixes

* **manifest:** honor object spread precedence in settings schema resolution ([13a71be](https://github.com/ubiquity-os/plugin-manifest-tool/commit/13a71beef4d808138828a1e0d36d9357b2bdae5f))
* **manifest:** resolve settingsSchema from option spreads ([4b6ca8f](https://github.com/ubiquity-os/plugin-manifest-tool/commit/4b6ca8f5379384d949ab2b5de105612e4b49640e))
* **manifest:** support spread-based settingsSchema resolution ([9258678](https://github.com/ubiquity-os/plugin-manifest-tool/commit/92586786a817cd53765c3b0248b13c9e4066a9a4))

## [1.1.0](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.0.2...v1.1.0) (2026-02-23)


### Features

* bundle deno runtime for manifest generation ([a7d8493](https://github.com/ubiquity-os/plugin-manifest-tool/commit/a7d8493947155304ed4958dc2fbe3d21fc96d248))
* bundle deno runtime for manifest generation ([4a4c3c9](https://github.com/ubiquity-os/plugin-manifest-tool/commit/4a4c3c9726bb5d82510d348bde176665a79e7ff3))


### Bug Fixes

* avoid false missing-deno hints for module import errors ([e8ab707](https://github.com/ubiquity-os/plugin-manifest-tool/commit/e8ab707e0ce1b3dc124fc45aaabdf32ec059a9c9))

## [1.0.2](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.0.1...v1.0.2) (2026-02-23)


### Bug Fixes

* make prepare script resilient when husky is unavailable ([1893641](https://github.com/ubiquity-os/plugin-manifest-tool/commit/18936418cb917981405205f79a8496572857f667))

## [1.0.1](https://github.com/ubiquity-os/plugin-manifest-tool/compare/v1.0.0...v1.0.1) (2026-02-23)


### Bug Fixes

* removed nvmrc ([472ebd3](https://github.com/ubiquity-os/plugin-manifest-tool/commit/472ebd31e74ea8a80cd1fe6fa9ddcd22c39c470b))

## 1.0.0 (2026-02-23)


### Features

* bootstrap plugin-manifest-tool as reusable CLI package ([583a4be](https://github.com/ubiquity-os/plugin-manifest-tool/commit/583a4be1881f78045667c226f0a3fc24061cec34))


### Bug Fixes

* set release-please release type to node ([8f5b471](https://github.com/ubiquity-os/plugin-manifest-tool/commit/8f5b471cbf183b3a70be49d8127290ef101a0e97))
* target release-please workflow to main ([7b6dbe0](https://github.com/ubiquity-os/plugin-manifest-tool/commit/7b6dbe0429df8d2147d79dd58abb48b3c1d55fc0))
