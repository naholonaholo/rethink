import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

const STERIL_MODES = ['off', 'on', 'power'] as const

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Fridge' }),
                components: {
                    fridge_temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-fridge_temp',
                        state_topic: '$this/fridge_temp',
                        name: 'Fridge temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                    },
                    freezer_temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-freezer_temp',
                        state_topic: '$this/freezer_temp',
                        name: 'Freezer temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                    },
                    rapid_cool: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rapid_cool',
                        state_topic: '$this/rapid_cool',
                        name: 'Rapid cool (특냉)',
                        icon: 'mdi:snowflake-alert',
                    },
                    steril: {
                        platform: 'sensor',
                        unique_id: '$deviceid-steril',
                        state_topic: '$this/steril',
                        name: 'Sterilization (제균탈취)',
                        icon: 'mdi:air-purifier',
                        device_class: 'enum',
                        options: [...STERIL_MODES],
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-lock',
                        state_topic: '$this/lock',
                        name: 'Touch lock',
                        device_class: 'lock',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            if (buf.length !== 12) {
                console.log(`[FRIDGE ${thinq.id}] undecoded len=${buf.length} hex=${buf.toString('hex')}`)
                return
            }

            const fridgeTemp = 7 - buf[1]
            const freezerTemp = -15 - buf[2]
            const rapidCool = buf[3] === 0x02
            const sterilRaw = buf[4]
            const steril = sterilRaw === 0x03 ? 'power' : sterilRaw === 0x02 ? 'on' : 'off'
            const doorOpen = buf[7] === 0x01
            const locked = buf[10] === 0x01

            this.publishProperty('fridge_temp', fridgeTemp)
            this.publishProperty('freezer_temp', freezerTemp)
            this.publishProperty('rapid_cool', rapidCool ? 'ON' : 'OFF')
            this.publishProperty('steril', steril)
            this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
            // binary_sensor device_class 'lock': ON = unlocked, OFF = locked (washer 파일의 door_lock과 동일한 관례)
            this.publishProperty('lock', locked ? 'OFF' : 'ON')
        })
    }

    monTimer: ReturnType<typeof setInterval> | undefined

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
        this.monTimer = setInterval(() => {
            this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
        }, 40_000)
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        // 진단 단계라 제어는 아직 구현하지 않음
    }
}
