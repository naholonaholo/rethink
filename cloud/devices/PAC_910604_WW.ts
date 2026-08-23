import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

type PowerModeChangeHook = () => void

// Live-captured private commands for PAC_910604_WW's humidity-sensor mode.
// 0 = measure only while the appliance is running, 1 = measure continuously.
const HUMIDITY_SENSOR_MODE_COMMANDS = {
    0: Buffer.from('01020400000065fd0100050c00000000b161', 'hex'),
    1: Buffer.from('01020400000065fd0100050c00000001a140', 'hex'),
} as const

export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    jetMode: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    pacFanOnlyStopTimeout: ReturnType<typeof setTimeout> | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    drop() {
        if (this.tlvBlacklistDisableTimer != undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout != undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

        if (this.pacFanOnlyStopTimeout != undefined) {
            clearTimeout(this.pacFanOnlyStopTimeout)
            this.pacFanOnlyStopTimeout = undefined
        }

        super.drop()
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            // 필터 관리 기능 미사용 - 필터 프로브를 건너뛰고 바로 설정 생성
            this.initMakeSetConfig()
        }, 500)
    }

    updateClimateAction() {
        // also updates query interval
        const modeTLV = this.getModeTLV()

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha = ['cooling', 'drying', undefined, undefined, undefined, 'fan']
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || modeTLV === 6) && !iduRunning) {
            action = 'idle'
        } else if (modeTLV === 6) {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = modes2ha[modeTLV]
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[0x189] != null) {
            return 0x189 // IDUThermoOnOff
        }
        if (this.raw_clip_state[0x6c] != null) {
            return 0x6c
        }

        return undefined
    }

    initMakeSetConfig() {
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    temp_step: 1,
                    precision: 1,
                    min_temp: 18,
                    max_temp: 30,
                    ...{ modes: ['off', 'cool', 'dry', 'fan_only'] },
                    fan_modes: ['약풍', '중풍', '강풍'],
                } satisfies ClimateComponent,
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x336,
            name: 'current_humidity',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
        })

        const humiditySensorMode = {
            platform: 'select',
            unique_id: '$deviceid-humidity_sensor_mode',
            name: 'Humidity sensor mode',
            icon: 'mdi:water-percent',
            entity_category: 'config',
            options: ['운전 중에만', '항상'],
        }
        config['components']['humidity_sensor_mode'] = humiditySensorMode
        this.addField(config, {
            id: 0x337,
            name: '',
            comp: 'humidity_sensor_mode',
            read_xform: (raw) => ({ 0: '운전 중에만', 1: '항상' })[raw],
            write_xform: (value) => ({ '운전 중에만': 0, 항상: 1 })[value],
            write_callback: (value) => {
                if (value !== 0 && value !== 1) return false
                this.thinq.send_packet(HUMIDITY_SENSOR_MODE_COMMANDS[value])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                const pacModes: Record<number, string> = { 0: 'cool', 1: 'dry', 5: 'fan_only' }
                if (this.getPowerTLV() === 0) return 'off'
                return pacModes[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 5 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                if (val === 'fan_only') {
                    // 전원이 꺼진 상태에서도 송풍 선택 시 자동으로 전원부터 켜기
                    this.setProperty('climate-power', 'ON')
                    this.setProperty('climate-fan_mode', '강풍')
                    return 5
                }
                return modes2clip[val]
            },
            write_callback: (raw) => {
                if (this.getModeTLV() === 5 && (raw === 0 || raw === 1)) {
                    this.schedulePacFanOnlyStop()
                }
                return true
            },
            write_attach: (raw) => (raw === 5 ? [] : [0x1fa, 0x1fe]),
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => {
                const pacModes: Record<number, string> = {
                    0x02: '약풍',
                    0x04: '중풍',
                    0x06: '강풍',
                }
                return pacModes[raw]
            },
            write_xform: (val) => {
                const pacModes: Record<string, number> = {
                    약풍: 0x0202,
                    중풍: 0x0404,
                    강풍: 0x0606,
                }
                return pacModes[val]
            },
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        // 회전모드(swing) 없는 모델이라 관련 필드 미사용

        if (this.getIDUActionRunningTLVNum() != null) {
            this.addField(
                config,
                {
                    id: this.getIDUActionRunningTLVNum(),
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.powerChangeHooks.push(() => {
            this.updateClimateAction()
        })
        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })

        // This PAC reports 0x20D in every full state response, so expose a
        // regular state-backed switch instead of an assumed-state control.
        this.addConfigSwitchField(config, 0x20d, 'energysave', 'Energy saving', 'mdi:flower')

        // PAC_910604_WW reports these live values even though its legacy
        // 0x2CC capability bits do not advertise them.
        this.addConfigSwitchField(config, 0x20e, 'autodry', 'Auto dry', 'mdi:hair-dryer')

        // Live command captures from this model:
        //   0x21F: front display light (1=on)
        //   0x23E: smart-care wind mode (1=on) - 리모컨 '스마트케어' 버튼과 동일
        this.addConfigSwitchField(config, 0x21f, 'displaylight', 'Display light', 'mdi:lightbulb')
        this.addConfigSwitchField(config, 0x23e, 'smartcare', 'Smart care', 'mdi:creation')

        this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
        this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)

        // 이 모델은 쿨파워가 IR 전용 기능이라 TLV로는 제어 불가.
        // 리모컨 쿨파워와 동일한 결과(냉방+18도+강풍)를 흉내내는 버튼으로 대체.
        const coolPower = {
            platform: 'button',
            unique_id: '$deviceid-cool_power',
            name: 'Cool power',
            icon: 'mdi:snowflake-alert',
            command_topic: '$this/cool_power/set',
            payload_press: 'PRESS',
        }
        config['components']['cool_power'] = coolPower

        this.setConfig(config)

        this.query()
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'cool_power') {
            // 리모컨 쿨파워와 동일: 냉방 모드 진입 + 18도 + 강풍
            this.setProperty('climate-mode', 'cool')
            this.setProperty('climate-temperature', '18')
            this.setProperty('climate-fan_mode', '강풍')
            return
        }
        super.setProperty(prop, mqttValue)
    }

    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        let id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    private schedulePacFanOnlyStop() {
        if (this.pacFanOnlyStopTimeout != undefined) clearTimeout(this.pacFanOnlyStopTimeout)
        this.pacFanOnlyStopTimeout = setTimeout(() => {
            this.pacFanOnlyStopTimeout = undefined
            this.send([1, 1, 2, 1, 0], [{ t: 0x20f, v: 0 }])
        }, 1400)
    }

    addConfigSwitchField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })
    }
}
