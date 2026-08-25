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
//
// 2026-08-25 좌칸 재조사: 좌칸(2-door)은 기존에 알던 4개(맛지킴중/강/약,익힘) 외에
// "냉장중/강/약"(값 3/4/5) 모드가 더 있다는 게 확인됨 (냉장고 터치판 직접 조작
// 캡쳐로 발견, 앱 조작으로 write 커맨드까지 확보 완료).
// "냉동"(값 6)은 여러 번 재시도했지만 write 커맨드가 전혀 캡쳐되지 않음 —
// 냉장고 터치판에서 직접 눌러야만 진입되는 모드로 보이며, MQTT/앱에서는 선택 불가.
// 그래서 냉동은 상태 read(현재값 표시)만 지원하고 write(선택)는 지원하지 않음.
//
// 2026-08-26 우칸/중칸/하칸 확장 캡처 (kimchi--capture.jsonl):
// - 우칸(room2): 기존 냉장중/강/약(3/4/5)에 맛지킴중/강/약(0/1/2)·익힘(7) 추가.
//   write 직전 note로 확정. 냉동은 write 미캡처(읽기전용) — 터치판 연타 구간에서
//   room2 값이 2→3→4→5→6→7 순으로 지나가는 게 관측됐고, 이 순서가 room1과
//   완전히 동일(맛지킴×3, 냉장×3, 냉동, 익힘)해서 냉동=6으로 판단. room1처럼
//   write 불가라 read-only 취급.
// - 중칸(room3): 기존 맛지킴/구입김치/유산균+/익힘에 야채/과일중/강/약(3/4/5) 추가,
//   write 직전 note로 확정. "중칸꺼짐"은 write 미캡처 — 터치판 연타 구간에서
//   기존 값들(0,1,2,3,4,5,6,7,11=익힘) 다음에 새 값 13이 두 번 반복 등장해서
//   13으로 추정되나, 캡처 중 그 상태에서 멈추지 않고 지나쳐서 100% 확정은 아님
//   (TODO: 재캡처로 확정 필요).
// - 하칸(room4): 기존 야채/과일중/강/약에 맛지킴중/강/약/오래보관(0/1/2/8)·
//   육류,생선(7) 추가, write 직전 note로 확정. "쌀,잡곡"과 "하칸꺼짐" 둘 다
//   write 미캡처 — 터치판 연타 구간에서 새 값 9가 딱 한 번만 등장해서 두 모드 중
//   어느 쪽인지, 나머지 하나의 값이 무엇인지 구분 불가 (TODO: 재캡처로 확정 필요,
//   그때까지 미구현).

const ROOM1_COMMANDS = {
    // 좌칸 (2-door compartment)
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100010000c7bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100010001c6bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100010002c1bb', 'hex'),
    냉장중: Buffer.from('aa0ff0e5000201ff0100010003c0bb', 'hex'),
    냉장강: Buffer.from('aa0ff0e5000201ff0100010004c3bb', 'hex'),
    냉장약: Buffer.from('aa0ff0e5000201ff0100010005c2bb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100010007ccbb', 'hex'),
} as const

const ROOM2_COMMANDS = {
    // 우칸 - 기존 냉장중/강/약 + 2026-08-26 확장: 맛지킴중/강/약, 익힘
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100020000c6bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100020001c1bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100020002c0bb', 'hex'),
    냉장중: Buffer.from('aa0ff0e5000201ff0100020003c3bb', 'hex'),
    냉장강: Buffer.from('aa0ff0e5000201ff0100020004c2bb', 'hex'),
    냉장약: Buffer.from('aa0ff0e5000201ff0100020005cdbb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100020007cfbb', 'hex'),
} as const

const ROOM3_COMMANDS = {
    // 중칸 (5-door compartment) - 기존 + 2026-08-26 확장: 야채/과일중/강/약
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100030000c1bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100030001c0bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100030002c3bb', 'hex'),
    야채중: Buffer.from('aa0ff0e5000201ff0100030003c2bb', 'hex'),
    야채강: Buffer.from('aa0ff0e5000201ff0100030004cdbb', 'hex'),
    야채약: Buffer.from('aa0ff0e5000201ff0100030005ccbb', 'hex'),
    구입김치: Buffer.from('aa0ff0e5000201ff0100030006cfbb', 'hex'),
    '유산균+': Buffer.from('aa0ff0e5000201ff0100030007cebb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff010003000bcabb', 'hex'),
} as const

const ROOM4_COMMANDS = {
    // 하칸 - 기존 야채/과일중/강/약 + 2026-08-26 확장: 맛지킴중/강/약, 오래보관, 육류생선
    맛지킴중: Buffer.from('aa0ff0e5000201ff0100040000c0bb', 'hex'),
    맛지킴강: Buffer.from('aa0ff0e5000201ff0100040001c3bb', 'hex'),
    맛지킴약: Buffer.from('aa0ff0e5000201ff0100040002c2bb', 'hex'),
    야채중: Buffer.from('aa0ff0e5000201ff0100040003cdbb', 'hex'),
    야채강: Buffer.from('aa0ff0e5000201ff0100040004ccbb', 'hex'),
    야채약: Buffer.from('aa0ff0e5000201ff0100040005cfbb', 'hex'),
    육류생선: Buffer.from('aa0ff0e5000201ff0100040007c9bb', 'hex'),
    맛지킴오래보관: Buffer.from('aa0ff0e5000201ff0100040008c8bb', 'hex'),
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

// write 커맨드를 못 구한 상태값들. select의 옵션 목록/상태 매핑에는 포함하되
// setProperty에서는 취급하지 않아 MQTT로는 선택할 수 없고, 냉장고에서 이
// 상태로 바뀌면 읽기로만 반영된다.
const ROOM1_READONLY_STATES = {
    냉동: 6,
} as const

const ROOM2_READONLY_STATES = {
    // room1과 동일한 enum 순서(맛지킴×3, 냉장×3, 냉동, 익힘)로 추정 확인됨.
    // 터치판 연타 구간에서 2→3→4→5→6→7 순으로 지나가는 게 관측됨.
    냉동: 6,
} as const

const ROOM3_READONLY_STATES = {
    // 터치판 연타 구간에서 익힘(11) 직후 13이 반복 등장 - 추정치, 미확정.
    중칸꺼짐: 13,
} as const

// room4의 "쌀,잡곡"과 "하칸꺼짐"은 아직 값을 확정하지 못해 미포함.
// 터치판 연타 캡처에서 새 값 9가 한 번만 나와서 둘 중 어느 쪽인지 불명확.
// 재캡처로 확정되면 여기에 ROOM4_READONLY_STATES로 추가 예정.

// --- 상태 read 프레임(11ec)용 역방향 매핑 -------------------------------
// 커맨드 버퍼 포맷: aa 0f f0 e5 00 02 01 ff 01 00 [ROOM] 00 [VALUE] [checksum] bb
// VALUE 바이트는 버퍼의 인덱스 12에 있고, 이 값이 11ec 상태 프레임의
// "현재 상태" 12바이트 청크 안에도 그대로 등장한다 (2026-08-25 캡쳐로 확인).
// room1=chunk[1], room2=chunk[2], room3=chunk[3], room4=chunk[4],
// onetouchfilter=chunk[6], door=chunk[8] (door는 기존에 이미 사용 중).
function buildValueMap<T extends Record<string, Buffer>>(commands: T): Map<number, string> {
    const map = new Map<number, string>()
    for (const key of Object.keys(commands) as (keyof T)[]) {
        map.set(commands[key][12], key as string)
    }
    return map
}

const ROOM1_VALUES = buildValueMap(ROOM1_COMMANDS)
for (const [label, value] of Object.entries(ROOM1_READONLY_STATES)) {
    ROOM1_VALUES.set(value, label)
}
const ROOM1_OPTIONS = [...Object.keys(ROOM1_COMMANDS), ...Object.keys(ROOM1_READONLY_STATES)]

const ROOM2_VALUES = buildValueMap(ROOM2_COMMANDS)
for (const [label, value] of Object.entries(ROOM2_READONLY_STATES)) {
    ROOM2_VALUES.set(value, label)
}
const ROOM2_OPTIONS = [...Object.keys(ROOM2_COMMANDS), ...Object.keys(ROOM2_READONLY_STATES)]

const ROOM3_VALUES = buildValueMap(ROOM3_COMMANDS)
for (const [label, value] of Object.entries(ROOM3_READONLY_STATES)) {
    ROOM3_VALUES.set(value, label)
}
const ROOM3_OPTIONS = [...Object.keys(ROOM3_COMMANDS), ...Object.keys(ROOM3_READONLY_STATES)]

const ROOM4_VALUES = buildValueMap(ROOM4_COMMANDS)
const ROOM4_OPTIONS = [...Object.keys(ROOM4_COMMANDS)]

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
                        options: ROOM1_OPTIONS,
                        optimistic: true,
                    },
                    room2: {
                        platform: 'select',
                        unique_id: '$deviceid-room2',
                        name: '우칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room2/set',
                        state_topic: '$this/room2',
                        options: ROOM2_OPTIONS,
                        optimistic: true,
                    },
                    room3: {
                        platform: 'select',
                        unique_id: '$deviceid-room3',
                        name: '중칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room3/set',
                        state_topic: '$this/room3',
                        options: ROOM3_OPTIONS,
                        optimistic: true,
                    },
                    room4: {
                        platform: 'select',
                        unique_id: '$deviceid-room4',
                        name: '하칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room4/set',
                        state_topic: '$this/room4',
                        options: ROOM4_OPTIONS,
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

        // 진단용: 원시 패킷을 계속 콘솔에 남겨서, 추후 room4의 쌀잡곡/하칸꺼짐 등
        // 미확정 값을 재캡처할 때 참고 자료로 쓸 수 있게 함. 기능에는 영향 없음.
        thinq.on('data', (buf: Buffer) => {
            console.log(`[KIMCHI-RAW ${thinq.id}] len=${buf.length} hex=${buf.toString('hex')}`)

            // 상태 알림 프레임: 11ec + [이전상태 12바이트] + [현재상태 12바이트]
            // "현재상태" 청크(offset 14부터)에 room1~4, 원터치탈취, door가
            // 모두 들어있음 (2026-08-25 캡처, notes 마커와 대조하여 전부 확인):
            //   current[1] = room1 값, current[2] = room2 값,
            //   current[3] = room3 값, current[4] = room4 값,
            //   current[6] = 원터치탈취(0/1), current[8] = door(0/1)
            // current[7], current[9], current[10], current[11]은 아직 미해독
            // (야간 눈부심 방지 관련으로 추정, 별도 조사 필요).
            // buf는 항상 aa + len(1) + body + checksum(1) + bb 로 감싸진 통짜
            // 프레임이다 (S5MPC.ts 스타일러 핸들러 참고).
            if (buf.length < 4 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) return
            const body = buf.subarray(2, buf.length - 2)

            if (body.length === 26 && body[0] === 0x11 && body[1] === 0xec) {
                const current = body.subarray(14, 26)

                const doorOpen = current[8] === 0x01
                this.publishProperty('door', doorOpen ? 'ON' : 'OFF')

                const room1 = ROOM1_VALUES.get(current[1])
                if (room1 !== undefined) this.publishProperty('room1', room1)

                const room2 = ROOM2_VALUES.get(current[2])
                if (room2 !== undefined) this.publishProperty('room2', room2)

                const room3 = ROOM3_VALUES.get(current[3])
                if (room3 !== undefined) this.publishProperty('room3', room3)

                const room4 = ROOM4_VALUES.get(current[4])
                if (room4 !== undefined) this.publishProperty('room4', room4)
                else
                    console.log(
                        `[KIMCHI-RAW ${thinq.id}] room4 미확인 값=${current[4]} (쌀잡곡/하칸꺼짐 재캡처용 참고)`,
                    )

                this.publishProperty('onetouchfilter', current[6] === 0x01 ? 'ON' : 'OFF')
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
                // 냉동(ROOM1_READONLY_STATES)은 write 커맨드가 없어 여기서 무시됨 -
                // 냉장고에서 상태가 바뀌면 read로만 반영되고, MQTT로는 선택 불가.
                if (mqttValue in ROOM1_COMMANDS) {
                    this.thinq.send_packet(ROOM1_COMMANDS[mqttValue as keyof typeof ROOM1_COMMANDS])
                    this.HA.publishProperty(this.id, 'room1', mqttValue)
                }
                return
            case 'room2':
                // 냉동(ROOM2_READONLY_STATES)은 마찬가지로 write 불가.
                if (mqttValue in ROOM2_COMMANDS) {
                    this.thinq.send_packet(ROOM2_COMMANDS[mqttValue as keyof typeof ROOM2_COMMANDS])
                    this.HA.publishProperty(this.id, 'room2', mqttValue)
                }
                return
            case 'room3':
                // 중칸꺼짐(ROOM3_READONLY_STATES)은 마찬가지로 write 불가.
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