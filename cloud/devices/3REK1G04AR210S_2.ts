import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { type Metadata } from '../thinq'

// Live-captured raw commands for the kimchi fridge (3REK1G04AR210S_2).
// Format: aa 0f f0 e5 00 02 01 ff 01 00 [ROOM] 00 [VALUE] [checksum] bb
// Captured directly from app control, cross-checked against the
// LG cloud "kmcState" reflection (roomNTemp) received via Bridge, so the
// value <-> label mapping below is confirmed, not guessed.
//
// 2026-08-24 재검증: room1(좌칸)과 room3(중칸)의 기존 값 매핑이 실제로는
// 틀려 있었음 (클라우드 kmcState.roomNTemp와 대조해서 정정함).
// room2(우칸), room4(하칸)는 재검증 결과 기존 값이 정확해서 그대로 둠.

const ROOM1_COMMANDS = {
    // 좌칸 (2-door compartment) - 옵션 4개만 있음
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100010000c7bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100010001c6bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100010002c1bb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100010007ccbb', 'hex'),
} as const

const ROOM2_COMMANDS = {
    // 우칸 (냉장) - 재검증 결과 기존 값 그대로 정확함
    냉장중: Buffer.from('aa0ff0e5000201ff0100020003c3bb', 'hex'),
    냉장강: Buffer.from('aa0ff0e5000201ff0100020004c2bb', 'hex'),
    냉장약: Buffer.from('aa0ff0e5000201ff0100020005cdbb', 'hex'),
} as const

const ROOM3_COMMANDS = {
    // 중칸 (5-door compartment, more options)
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100030000c1bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100030001c0bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100030002c3bb', 'hex'),
    구입김치: Buffer.from('aa0ff0e5000201ff0100030006cfbb', 'hex'),
    '유산균+': Buffer.from('aa0ff0e5000201ff0100030007cebb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff010003000bcabb', 'hex'),
} as const

const ROOM4_COMMANDS = {
    // 하칸 (야채/과일) - 재검증 결과 기존 값 그대로 정확함
    야채중: Buffer.from('aa0ff0e5000201ff0100040003cdbb', 'hex'),
    야채강: Buffer.from('aa0ff0e5000201ff0100040004ccbb', 'hex'),
    야채약: Buffer.from('aa0ff0e5000201ff0100040005cfbb', 'hex'),
} as const

const ONE_TOUCH_FILTER_COMMANDS = {
    0: Buffer.from('aa0ff0e5000201ff0100060000c2bb', 'hex'), // OFF
    1: Buffer.from('aa0ff0e5000201ff0100060001cdbb', 'hex'), // ON
} as const

// 야간 눈부심 방지 - captured with fixed "일몰에서 일출까지" schedule.
// If a custom time schedule is ever needed, this would need a fresh capture.
const NIGHT_ANTI_GLARE_COMMANDS = {
    사용안함: Buffer.from('aa1bf01002000000000000000000000000000046ffffffffff5dbb', 'hex'),
    '10%': Buffer.from('aa1bf01002011a08180a05351a0818143400000affffffffff98bb', 'hex'),
    '30%': Buffer.from('aa1bf01002011a08180a060a1a0818143400001effffffffffe2bb', 'hex'),
    '50%': Buffer.from('aa1bf01002011a08180a06161a08181434000032ffffffffff82bb', 'hex'),
    '70%': Buffer.from('aa1bf01002011a08180a06231a08181434000046ffffffffffadbb', 'hex'),
} as const

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Kimchi Fridge' }),
                components: {
                    room1: {
                        platform: 'select',
                        unique_id: '$deviceid-room1',
                        name: '좌칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room1/set',
                        state_topic: '$this/room1',
                        options: Object.keys(ROOM1_COMMANDS),
                        optimistic: true,
                    },
                    room2: {
                        platform: 'select',
                        unique_id: '$deviceid-room2',
                        name: '우칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room2/set',
                        state_topic: '$this/room2',
                        options: Object.keys(ROOM2_COMMANDS),
                        optimistic: true,
                    },
                    room3: {
                        platform: 'select',
                        unique_id: '$deviceid-room3',
                        name: '중칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room3/set',
                        state_topic: '$this/room3',
                        options: Object.keys(ROOM3_COMMANDS),
                        optimistic: true,
                    },
                    room4: {
                        platform: 'select',
                        unique_id: '$deviceid-room4',
                        name: '하칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room4/set',
                        state_topic: '$this/room4',
                        options: Object.keys(ROOM4_COMMANDS),
                        optimistic: true,
                    },
                    onetouchfilter: {
                        platform: 'switch',
                        unique_id: '$deviceid-onetouchfilter',
                        name: '원터치 탈취',
                        icon: 'mdi:air-purifier',
                        command_topic: '$this/onetouchfilter/set',
                        state_topic: '$this/onetouchfilter',
                        optimistic: true,
                    },
                    nightantiglare: {
                        platform: 'select',
                        unique_id: '$deviceid-nightantiglare',
                        name: '야간 눈부심 방지',
                        icon: 'mdi:weather-night',
                        command_topic: '$this/nightantiglare/set',
                        state_topic: '$this/nightantiglare',
                        options: Object.keys(NIGHT_ANTI_GLARE_COMMANDS),
                        optimistic: true,
                    },
                    door: {
                        // 좌/우/중/하칸 구분 없이 "문 중 하나라도 열림"을 나타내는
                        // 단일 플래그. 2026-08-24 캡처에서 4개 칸 전부 open/close
                        // 4회 사이클 동안 동일 패턴으로 100% 일치 확인됨.
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        name: '문 열림',
                        device_class: 'door',
                        state_topic: '$this/door',
                    },
                },
            }),
        )

        // 진단용: 원시 패킷을 계속 콘솔에 남겨서, 추후 칸별 온도값(read) 디코딩을
        // 시도할 때 참고 자료로 쓸 수 있게 함. 기능에는 영향 없음.
        thinq.on('data', (buf: Buffer) => {
            console.log(`[KIMCHI-RAW ${thinq.id}] len=${buf.length} hex=${buf.toString('hex')}`)

            // 문 열림/닫힘 알림 프레임: 11ec + [이전상태 12바이트] + [현재상태 12바이트]
            // 현재상태 청크(offset 14)의 offset 22 위치가 문 열림(1)/닫힘(0) 플래그.
            // (2026-08-24 캡처, open/close 4회 사이클 모두 일치 확인)
            if (buf.length === 26 && buf[0] === 0x11 && buf[1] === 0xec) {
                const doorOpen = buf[22] === 0x01
                this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
            }
        })
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return
        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'room1':
                if (mqttValue in ROOM1_COMMANDS) {
                    this.thinq.send_packet(ROOM1_COMMANDS[mqttValue as keyof typeof ROOM1_COMMANDS])
                    this.HA.publishProperty(this.id, 'room1', mqttValue)
                }
                return
            case 'room2':
                if (mqttValue in ROOM2_COMMANDS) {
                    this.thinq.send_packet(ROOM2_COMMANDS[mqttValue as keyof typeof ROOM2_COMMANDS])
                    this.HA.publishProperty(this.id, 'room2', mqttValue)
                }
                return
            case 'room3':
                if (mqttValue in ROOM3_COMMANDS) {
                    this.thinq.send_packet(ROOM3_COMMANDS[mqttValue as keyof typeof ROOM3_COMMANDS])
                    this.HA.publishProperty(this.id, 'room3', mqttValue)
                }
                return
            case 'room4':
                if (mqttValue in ROOM4_COMMANDS) {
                    this.thinq.send_packet(ROOM4_COMMANDS[mqttValue as keyof typeof ROOM4_COMMANDS])
                    this.HA.publishProperty(this.id, 'room4', mqttValue)
                }
                return
            case 'onetouchfilter': {
                const v = mqttValue === 'ON' ? 1 : 0
                this.thinq.send_packet(ONE_TOUCH_FILTER_COMMANDS[v])
                this.HA.publishProperty(this.id, 'onetouchfilter', mqttValue)
                return
            }
            case 'nightantiglare':
                if (mqttValue in NIGHT_ANTI_GLARE_COMMANDS) {
                    this.thinq.send_packet(NIGHT_ANTI_GLARE_COMMANDS[mqttValue as keyof typeof NIGHT_ANTI_GLARE_COMMANDS])
                    this.HA.publishProperty(this.id, 'nightantiglare', mqttValue)
                }
                return
        }
        super.setProperty(prop, mqttValue)
    }
}