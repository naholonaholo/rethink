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
//   육류,생선(7) 추가, write 직전 note로 확정.
//
// 2026-08-27 하칸(room4) "쌀,잡곡"/"하칸꺼짐" 확정 (kimchi-capture.jsonl):
// 터치판에서 두 조작을 시간 나눠서(15:44:30 쌀/잡곡, 15:45:00 하칸꺼짐) 진행,
// 11ec 상태 프레임의 current[4] 값 전환 타이밍과 1초 이내로 정확히 일치:
//   15:44:31 프레임에서 current[4] 5→6 (쌀/잡곡 조작 직후) → 쌀,잡곡 = 6
//   15:45:01 프레임에서 current[4] 8→9 (하칸꺼짐 조작 직후) → 하칸꺼짐 = 9
// 다만 이번에도 write 커맨드(f0e5)는 캡쳐되지 않음 (터치판 직접 조작이라
// room1 냉동, room3 중칸꺼짐과 동일하게 read-only 취급).
//
// 2026-08-25 야간 눈부심 방지 - 기존엔 캡처한 고정 hex(날짜정보 내장)를 그대로
// 재사용해서 하루 지나면 기기가 무시하는 버그가 있었음. 원인/공식을 완전히
// 해독해서(체크섬 = aa+길이+본문 합(&0xff) XOR 0x55, rethink 자체
// util/packet-codec.ts의 aabbChecksum()과 동일 공식, 실측 검증 완료) 매번
// 오늘 날짜로 새로 조립하도록 변경. 기존 select(사용안함/10%/30%/50%/70%)는
// 그대로 두고, "시간설정"(커스텀 시작~종료 시각) 옵션과 그에 필요한
// 시작/종료 시(時)·분 입력 엔티티 4개만 추가함.
// 시각 인코딩: 이 기기는 자정이 아니라 오전 9시를 하루 경계로 씀
//   (시각>=9시: enc=시각-9,날짜=그대로 / 시각<9시: enc=시각+15,날짜=하루전).
// 상태 read(현재 모드/밝기)는 로컬 패킷에서 아직 못 찾아 optimistic 유지.

const ROOM1_COMMANDS = {
    // 좌칸 (2-door compartment)
    '맛지킴(중)': Buffer.from('aa0ff0e5000201ff0100010000c7bb', 'hex'),
    '맛지킴(강)': Buffer.from('aa0ff0e5000201ff0100010001c6bb', 'hex'),
    '맛지킴(약)': Buffer.from('aa0ff0e5000201ff0100010002c1bb', 'hex'),
    '냉장(중)': Buffer.from('aa0ff0e5000201ff0100010003c0bb', 'hex'),
    '냉장(강)': Buffer.from('aa0ff0e5000201ff0100010004c3bb', 'hex'),
    '냉장(약)': Buffer.from('aa0ff0e5000201ff0100010005c2bb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100010007ccbb', 'hex'),
} as const

const ROOM2_COMMANDS = {
    // 우칸 - 기존 냉장중/강/약 + 2026-08-26 확장: 맛지킴중/강/약, 익힘
    '맛지킴(중)': Buffer.from('aa0ff0e5000201ff0100020000c6bb', 'hex'),
    '맛지킴(강)': Buffer.from('aa0ff0e5000201ff0100020001c1bb', 'hex'),
    '맛지킴(약)': Buffer.from('aa0ff0e5000201ff0100020002c0bb', 'hex'),
    '냉장(중)': Buffer.from('aa0ff0e5000201ff0100020003c3bb', 'hex'),
    '냉장(강)': Buffer.from('aa0ff0e5000201ff0100020004c2bb', 'hex'),
    '냉장(약)': Buffer.from('aa0ff0e5000201ff0100020005cdbb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff0100020007cfbb', 'hex'),
} as const

const ROOM3_COMMANDS = {
    // 중칸 (5-door compartment) - 기존 + 2026-08-26 확장: 야채/과일중/강/약
    '맛지킴(중)': Buffer.from('aa0ff0e5000201ff0100030000c1bb', 'hex'),
    '맛지킴(강)': Buffer.from('aa0ff0e5000201ff0100030001c0bb', 'hex'),
    '맛지킴(약)': Buffer.from('aa0ff0e5000201ff0100030002c3bb', 'hex'),
    '과일/야채(중)': Buffer.from('aa0ff0e5000201ff0100030003c2bb', 'hex'),
    '과일/야채(강)': Buffer.from('aa0ff0e5000201ff0100030004cdbb', 'hex'),
    '과일/야채(약)': Buffer.from('aa0ff0e5000201ff0100030005ccbb', 'hex'),
    구입김치: Buffer.from('aa0ff0e5000201ff0100030006cfbb', 'hex'),
    '유산균+': Buffer.from('aa0ff0e5000201ff0100030007cebb', 'hex'),
    익힘: Buffer.from('aa0ff0e5000201ff010003000bcabb', 'hex'),
} as const

const ROOM4_COMMANDS = {
    // 하칸 - 기존 야채/과일중/강/약 + 2026-08-26 확장: 맛지킴중/강/약, 오래보관, 육류생선
    '맛지킴(중)': Buffer.from('aa0ff0e5000201ff0100040000c0bb', 'hex'),
    '맛지킴(강)': Buffer.from('aa0ff0e5000201ff0100040001c3bb', 'hex'),
    '맛지킴(약)': Buffer.from('aa0ff0e5000201ff0100040002c2bb', 'hex'),
    '과일/야채(중)': Buffer.from('aa0ff0e5000201ff0100040003cdbb', 'hex'),
    '과일/야채(강)': Buffer.from('aa0ff0e5000201ff0100040004ccbb', 'hex'),
    '과일/야채(약)': Buffer.from('aa0ff0e5000201ff0100040005cfbb', 'hex'),
    '육류/생선': Buffer.from('aa0ff0e5000201ff0100040007c9bb', 'hex'),
    '맛지킴(오래보관)': Buffer.from('aa0ff0e5000201ff0100040008c8bb', 'hex'),
} as const

const ONE_TOUCH_FILTER_COMMANDS = {
    0: Buffer.from('aa0ff0e5000201ff0100060000c2bb', 'hex'), // OFF
    1: Buffer.from('aa0ff0e5000201ff0100060001cdbb', 'hex'), // ON
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

const ROOM4_READONLY_STATES = {
    // 2026-08-27 확정: 터치판 조작 시각(15:44:30/15:45:00)과 11ec 상태 프레임의
    // current[4] 전환 타이밍이 1초 이내로 정확히 일치해서 확정.
    '쌀,잡곡': 6,
    하칸꺼짐: 9,
} as const

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
for (const [label, value] of Object.entries(ROOM4_READONLY_STATES)) {
    ROOM4_VALUES.set(value, label)
}
const ROOM4_OPTIONS = [...Object.keys(ROOM4_COMMANDS), ...Object.keys(ROOM4_READONLY_STATES)]

// 야간 눈부심 방지 - 앱 화면 구조(사용안함 / 일몰~일출[10~70%] / 시간설정[10~70%])
// 그대로 드롭다운 하나에 9개 옵션으로 평탄화. 선택할 때마다 모드+밝기가 한 번에
// 정해지므로 별도로 밝기를 "기억"해둘 필요가 없음. 날짜/체크섬은 매번 실시간 계산.
const NIGHT_ANTI_GLARE_OPTIONS = [
    '사용안함',
    '일몰에서 일출까지 10%',
    '일몰에서 일출까지 30%',
    '일몰에서 일출까지 50%',
    '일몰에서 일출까지 70%',
    '시간설정 10%',
    '시간설정 30%',
    '시간설정 50%',
    '시간설정 70%',
] as const

const NIGHT_BRIGHTNESS_BYTES: Record<string, number> = {
    '10%': 0x0a,
    '30%': 0x1e,
    '50%': 0x32,
    '70%': 0x46,
}

const NIGHT_OFF_COMMAND = Buffer.from('aa1bf01002000000000000000000000000000046ffffffffff5dbb', 'hex')

function aabbChecksum(bytes: Buffer): number {
    let sum = 0
    for (const b of bytes) sum += b
    return (sum & 0xff) ^ 0x55
}

// hour(0~23)를 "오전 9시를 하루의 경계로 삼는" 인코딩으로 변환.
// dayOffset: 그 시각이 오늘(0) 기준 실제 달력으로 며칠 뒤인지.
function encodeNightTime(hour: number, dayOffset: number, today: number): [number, number] {
    if (hour >= 9) return [hour - 9, today + dayOffset]
    return [hour + 24 - 9, today + dayOffset - 1]
}

function buildSunsetRiseCommand(brightnessByte: number): Buffer {
    const today = new Date().getDate()
    const body = Buffer.from('1002011a08190a05001a0819143500000affffffffff', 'hex')
    body[6] = today
    body[12] = today
    body[17] = brightnessByte
    const head = Buffer.from([0xaa, body.length + 4])
    const withoutChecksum = Buffer.concat([head, body])
    const checksum = aabbChecksum(withoutChecksum)
    return Buffer.concat([withoutChecksum, Buffer.from([checksum, 0xbb])])
}

function buildCustomCommand(
    startHour: number,
    startMin: number,
    endHour: number,
    endMin: number,
    brightnessByte: number,
): Buffer {
    const today = new Date().getDate()

    const startTotal = startHour * 60 + startMin
    const endTotal = endHour * 60 + endMin
    const endDayOffset = endTotal <= startTotal ? 1 : 0

    const [startEnc, startDay] = encodeNightTime(startHour, 0, today)
    const [endEnc, endDay] = encodeNightTime(endHour, endDayOffset, today)

    const body = Buffer.alloc(23)
    body[0] = 0xf0
    body[1] = 0x10
    body[2] = 0x02
    body[3] = 0x02
    body[4] = 0x1a
    body[5] = 0x08
    body[6] = startDay
    body[7] = startEnc
    body[8] = startMin
    body[9] = 0x00
    body[10] = 0x1a
    body[11] = 0x08
    body[12] = endDay
    body[13] = endEnc
    body[14] = endMin
    body[15] = 0x00
    body[16] = 0x00
    body[17] = brightnessByte
    body[18] = body[19] = body[20] = body[21] = body[22] = 0xff

    const head = Buffer.from([0xaa, body.length + 4])
    const withoutChecksum = Buffer.concat([head, body])
    const checksum = aabbChecksum(withoutChecksum)
    return Buffer.concat([withoutChecksum, Buffer.from([checksum, 0xbb])])
}

export default class Device extends HADevice {
    // "시간설정" 선택 시 사용할 시작/종료 시각과 밝기. number 엔티티에서 값이
    // 바뀔 때마다 여기 캐시해두고, nightantiglare가 "시간설정"일 때만 이 값으로 전송.
    nightCustomStartHour = 21
    nightCustomStartMin = 0
    nightCustomEndHour = 6
    nightCustomEndMin = 0

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
                        name: '1.좌칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room1/set',
                        state_topic: '$this/room1',
                        options: ROOM1_OPTIONS,
                        optimistic: true,
                    },
                    room2: {
                        platform: 'select',
                        unique_id: '$deviceid-room2',
                        name: '2.우칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room2/set',
                        state_topic: '$this/room2',
                        options: ROOM2_OPTIONS,
                        optimistic: true,
                    },
                    room3: {
                        platform: 'select',
                        unique_id: '$deviceid-room3',
                        name: '3.중칸',
                        icon: 'mdi:fridge-outline',
                        command_topic: '$this/room3/set',
                        state_topic: '$this/room3',
                        options: ROOM3_OPTIONS,
                        optimistic: true,
                    },
                    room4: {
                        platform: 'select',
                        unique_id: '$deviceid-room4',
                        name: '4.하칸',
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
                        // unique_id는 기존 그대로 유지 - 바꾸면 HA가 새 엔티티로 인식해서
                        // 기존에 대시보드/자동화에서 쓰던 참조가 다 끊어짐.
                        platform: 'select',
                        unique_id: '$deviceid-nightantiglare',
                        name: '야간 눈부심 방지',
                        icon: 'mdi:weather-night',
                        command_topic: '$this/nightantiglare/set',
                        state_topic: '$this/nightantiglare',
                        options: [...NIGHT_ANTI_GLARE_OPTIONS],
                        optimistic: true,
                    },
                    nightantiglare_start_hour: {
                        platform: 'number',
                        unique_id: '$deviceid-nightantiglare_start_hour',
                        name: '야간모드 시작 시(時)',
                        icon: 'mdi:clock-start',
                        command_topic: '$this/nightantiglare_start_hour/set',
                        state_topic: '$this/nightantiglare_start_hour',
                        min: 0,
                        max: 23,
                        step: 1,
                        optimistic: true,
                        entity_category: 'config',
                    },
                    nightantiglare_start_min: {
                        platform: 'number',
                        unique_id: '$deviceid-nightantiglare_start_min',
                        name: '야간모드 시작 분',
                        icon: 'mdi:clock-start',
                        command_topic: '$this/nightantiglare_start_min/set',
                        state_topic: '$this/nightantiglare_start_min',
                        min: 0,
                        max: 59,
                        step: 1,
                        optimistic: true,
                        entity_category: 'config',
                    },
                    nightantiglare_end_hour: {
                        platform: 'number',
                        unique_id: '$deviceid-nightantiglare_end_hour',
                        name: '야간모드 종료 시(時)',
                        icon: 'mdi:clock-end',
                        command_topic: '$this/nightantiglare_end_hour/set',
                        state_topic: '$this/nightantiglare_end_hour',
                        min: 0,
                        max: 23,
                        step: 1,
                        optimistic: true,
                        entity_category: 'config',
                    },
                    nightantiglare_end_min: {
                        platform: 'number',
                        unique_id: '$deviceid-nightantiglare_end_min',
                        name: '야간모드 종료 분',
                        icon: 'mdi:clock-end',
                        command_topic: '$this/nightantiglare_end_min/set',
                        state_topic: '$this/nightantiglare_end_min',
                        min: 0,
                        max: 59,
                        step: 1,
                        optimistic: true,
                        entity_category: 'config',
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

        // 진단용: 원시 패킷을 계속 콘솔에 남겨서, 추후 미확정 값을 재캡처할 때
        // 참고 자료로 쓸 수 있게 함. 기능에는 영향 없음.
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
                else console.log(`[KIMCHI-RAW ${thinq.id}] room4 미확인 값=${current[4]}`)

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
                // 쌀,잡곡/하칸꺼짐(ROOM4_READONLY_STATES)은 마찬가지로 write 불가.
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
            case 'nightantiglare': {
                if (!(NIGHT_ANTI_GLARE_OPTIONS as readonly string[]).includes(mqttValue)) return

                let packet: Buffer
                if (mqttValue === '사용안함') {
                    packet = NIGHT_OFF_COMMAND
                } else if (mqttValue.startsWith('시간설정 ')) {
                    const brightnessLabel = mqttValue.replace('시간설정 ', '')
                    packet = buildCustomCommand(
                        this.nightCustomStartHour,
                        this.nightCustomStartMin,
                        this.nightCustomEndHour,
                        this.nightCustomEndMin,
                        NIGHT_BRIGHTNESS_BYTES[brightnessLabel],
                    )
                } else {
                    // '일몰에서 일출까지 10%' 등
                    const brightnessLabel = mqttValue.replace('일몰에서 일출까지 ', '')
                    packet = buildSunsetRiseCommand(NIGHT_BRIGHTNESS_BYTES[brightnessLabel])
                }

                this.thinq.send_packet(packet)
                this.HA.publishProperty(this.id, 'nightantiglare', mqttValue)
                return
            }
            case 'nightantiglare_start_hour': {
                const v = Number(mqttValue)
                if (!Number.isFinite(v) || v < 0 || v > 23) return
                this.nightCustomStartHour = v
                this.HA.publishProperty(this.id, 'nightantiglare_start_hour', v)
                return
            }
            case 'nightantiglare_start_min': {
                const v = Number(mqttValue)
                if (!Number.isFinite(v) || v < 0 || v > 59) return
                this.nightCustomStartMin = v
                this.HA.publishProperty(this.id, 'nightantiglare_start_min', v)
                return
            }
            case 'nightantiglare_end_hour': {
                const v = Number(mqttValue)
                if (!Number.isFinite(v) || v < 0 || v > 23) return
                this.nightCustomEndHour = v
                this.HA.publishProperty(this.id, 'nightantiglare_end_hour', v)
                return
            }
            case 'nightantiglare_end_min': {
                const v = Number(mqttValue)
                if (!Number.isFinite(v) || v < 0 || v > 59) return
                this.nightCustomEndMin = v
                this.HA.publishProperty(this.id, 'nightantiglare_end_min', v)
                return
            }
        }
        super.setProperty(prop, mqttValue)
    }
}
