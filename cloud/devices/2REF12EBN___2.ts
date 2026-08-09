import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

const STERIL_MODES = ['off', 'on', 'power'] as const
type SterilMode = (typeof STERIL_MODES)[number]

// 관측된 실제 상태를 반영한 합리적 기본값
// (아직 첫 상태 리포트를 못 받은 상태에서 setProperty가 먼저 호출될 경우의 안전장치)
const DEFAULT_STATE = {
    fridgeTemp: 3,
    freezerTemp: -20,
    rapidCool: false,
    steril: 'off' as SterilMode,
}

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
                        platform: 'number',
                        unique_id: '$deviceid-fridge_temp',
                        state_topic: '$this/fridge_temp',
                        command_topic: '$this/fridge_temp/set',
                        name: 'Fridge temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        min: 0,
                        max: 6,
                        step: 1,
                        optimistic: true,
                    },
                    freezer_temp: {
                        platform: 'number',
                        unique_id: '$deviceid-freezer_temp',
                        state_topic: '$this/freezer_temp',
                        command_topic: '$this/freezer_temp/set',
                        name: 'Freezer temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        min: -24,
                        max: -16,
                        step: 1,
                        optimistic: true,
                    },
                    rapid_cool: {
                        platform: 'switch',
                        unique_id: '$deviceid-rapid_cool',
                        state_topic: '$this/rapid_cool',
                        command_topic: '$this/rapid_cool/set',
                        name: 'Rapid cool (특냉)',
                        icon: 'mdi:snowflake-alert',
                        optimistic: true,
                    },
                    steril: {
                        platform: 'select',
                        unique_id: '$deviceid-steril',
                        state_topic: '$this/steril',
                        command_topic: '$this/steril/set',
                        name: 'Sterilization (제균탈취)',
                        icon: 'mdi:air-purifier',
                        options: [...STERIL_MODES],
                        optimistic: true,
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
            const steril: SterilMode = sterilRaw === 0x03 ? 'power' : sterilRaw === 0x02 ? 'on' : 'off'
            const doorOpen = buf[7] === 0x01
            const locked = buf[10] === 0x01

            // Control 패킷을 만들 때 쓸 최신 상태 캐시 (기기 리포트가 유일한 진실 공급원)
            this.rawState = { fridgeTemp, freezerTemp, rapidCool, steril }

            this.publishProperty('fridge_temp', fridgeTemp)
            this.publishProperty('freezer_temp', freezerTemp)
            this.publishProperty('rapid_cool', rapidCool ? 'ON' : 'OFF')
            this.publishProperty('steril', steril)
            this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
            // binary_sensor device_class 'lock': ON = unlocked, OFF = locked (washer 파일의 door_lock과 동일한 관례)
            this.publishProperty('lock', locked ? 'OFF' : 'ON')
        })
    }

    rawState = { ...DEFAULT_STATE }

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

    sendControl() {
        const s = this.rawState
        const buf = Buffer.from([
            7 - s.fridgeTemp,
            -15 - s.freezerTemp,
            s.rapidCool ? 0x02 : 0x01,
            s.steril === 'power' ? 0x03 : s.steril === 'on' ? 0x02 : 0x01,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ])
        this.thinq.send({
            Cmd: 'Control',
            CmdOpt: 'Set',
            Value: 'ControlData',
            Format: 'B64',
            Data: buf.toString('base64'),
        })
        // 40초 주기 폴링을 기다리지 않고, 기기가 커맨드를 처리할 시간을 준 뒤
        // 곧바로 한 번 더 상태를 물어봐서 반영 지연을 1~2초 수준으로 줄임
        setTimeout(() => {
            this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
        }, 1500)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fridge_temp') {
            const v = Number(mqttValue)
            if (!Number.isFinite(v) || v < 0 || v > 6) return
            this.rawState.fridgeTemp = v
        } else if (prop === 'freezer_temp') {
            const v = Number(mqttValue)
            if (!Number.isFinite(v) || v < -24 || v > -16) return
            this.rawState.freezerTemp = v
        } else if (prop === 'rapid_cool') {
            this.rawState.rapidCool = mqttValue === 'ON'
        } else if (prop === 'steril') {
            if (!STERIL_MODES.includes(mqttValue as SterilMode)) return
            this.rawState.steril = mqttValue as SterilMode
        } else {
            return
        }

        this.sendControl()
    }
}