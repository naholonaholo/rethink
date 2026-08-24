import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { type Metadata } from '../thinq'

// Live-captured raw commands for the kimchi fridge (3REK1G04AR210S_2).
// Format: aa 0f f0 e5 00 02 01 ff 01 00 [ROOM] 00 [VALUE] [checksum] bb
// Captured directly from app control, so these are known-good regardless
// of the (not yet reverse-engineered) checksum algorithm.

const ROOM1_COMMANDS = {
    // 좌칸 (2-door compartment)
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100010000c7bb', 'hex'),
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100010001c6bb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100010002c1bb', 'hex'),
} as const

const ROOM2_COMMANDS = {
    // 우칸 (냉장)
    냉장중: Buffer.from('aa0ff0e5000201ff0100020003c3bb', 'hex'),
    냉장강: Buffer.from('aa0ff0e5000201ff0100020004c2bb', 'hex'),
    냉장약: Buffer.from('aa0ff0e5000201ff0100020005cdbb', 'hex'),
} as const

const ROOM3_COMMANDS = {
    // 중칸 (5-door compartment, more options)
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100030000c1bb', 'hex'),
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100030001c0bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100030002c3bb', 'hex'),
    구입김치: Buffer.from('aa0ff0e5000201ff0100030002c3bb', 'hex'), // note: same code as 맛지킴강 (captured as-is)
    '유산균+': Buffer.from('aa0ff0e5000201ff0100030006cfbb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100030007cebb', 'hex'),
} as const

const ROOM4_COMMANDS = {
    // 하칸 (야채/과일)
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
                },
            }),
        )

        // 진단용: 원시 패킷을 계속 콘솔에 남겨서, 추후 상태읽기(read) 디코딩을
        // 시도할 때 참고 자료로 쓸 수 있게 함. 기능에는 영향 없음.
        thinq.on('data', (buf: Buffer) => {
            console.log(`[KIMCHI-RAW ${thinq.id}] len=${buf.length} hex=${buf.toString('hex')}`)
        })
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
