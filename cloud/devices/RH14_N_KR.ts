// cloud/devices/RH14_N_KR.ts
// LG 건조기 (RH14_N_KR) - 상태조회 전용 핸들러
// thinq2 프로토콜: 기기가 상태 변화마다 스스로 aabb 프레임을 push하므로
// 별도 폴링 없이 thinq.on('data', ...)만으로 충분함. 원격제어는 구현하지 않음.
//
// 2026-08-27 실측 캡처(dryer-capture.jsonl)로 두 가지 수정:
// 1) payload[3],[4]와 payload[5],[6]의 역할이 반대로 되어 있었음.
//    - payload[3],[4] (기존 setHour/Minute)  -> 실제로는 1분마다 줄어드는 "남은시간"
//    - payload[5],[6] (기존 remainHour/Minute) -> 실제로는 코스 시작 직후 한 번 정해지고
//      끝까지 고정되는 "예정 총 소요시간" (세탁기 핸들러의 initial_time과 동일 개념)
//    실측: 15:01:43 남은시간이 1:05로 보정된 뒤, 15:24:55에 0:26까지 착실히
//    줄어드는 동안 예정시간 필드는 1:05로 끝까지 고정됨.
// 2) 종료 시퀀스에서 등장하는 미해독 값 확정:
//    - state 0x04 = 완료 직후, 완전히 꺼지기 전 짧은 "완료 알림" 상태
//    - process_state 0x07 = state 0x04와 동시 등장하는 완료 하위 상태
//    - course 0x00 = 꺼짐/코스 미선택 상태에서 나오는 값 (에러 아님)

import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

const STATE_CODES: Record<number, string> = {
    0x00: 'off',
    0x01: 'idle',
    0x02: 'running',
    0x03: 'paused',
    0x04: 'finished', // 완료 직후 짧은 알림 상태 (2026-08-27 캡처로 확인)
}

const COURSE_CODES: Record<number, string> = {
    0x00: '없음', // 꺼짐/코스 미선택
    0x02: '타월',
    0x04: '이불',
    0x05: '셔츠',
    0x07: '표준',
    0x08: '기능성의류',
    0x09: '소량급속',
    0x0b: '울/섬세',
    0x0c: '선반건조',
    0x0d: '시간건조 송풍',
    0x0e: '시간건조 온풍',
    0x0f: '침구털기',
    0x10: '살균',
    0x11: '강력',
    0x13: '통살균',
    0x14: '패딩리프레쉬',
    0x16: '다운로드코스',
}

const DRY_LEVEL_CODES: Record<number, string> = {
    0x00: 'none',
    0x03: 'iron',
}

const ECO_HYBRID_CODES: Record<number, string> = {
    0x00: 'off',
    0x01: 'eco',
    0x02: 'normal',
    0x03: 'turbo',
}

const PROCESS_STATE_CODES: Record<number, string> = {
    0x00: 'detecting',
    0x02: 'dry_lv1',
    0x03: 'dry_lv2',
    0x04: 'dry_lv3',
    0x05: 'cool',
    0x07: 'finished', // state 0x04와 함께 등장하는 완료 하위 상태 (추정, 재확인 필요)
}

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-state',
                        state_topic: '$this/state',
                        name: 'State',
                        icon: 'mdi:tumble-dryer',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:playlist-check',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    process_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process_state',
                        state_topic: '$this/process_state',
                        name: 'Process state',
                        icon: 'mdi:progress-clock',
                        entity_category: 'diagnostic',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        entity_category: 'diagnostic',
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco hybrid',
                        icon: 'mdi:leaf',
                        entity_category: 'diagnostic',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti-crease',
                        icon: 'mdi:tshirt-crew',
                        entity_category: 'diagnostic',
                    },
                    smart_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-smart_care',
                        state_topic: '$this/smart_care',
                        name: 'Smart care',
                        icon: 'mdi:creation',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            // aa + len(1) + body + checksum(1) + bb 프레이밍 벗기기
            if (buf.length < 4 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) {
                console.log(`[DRYER ${thinq.id}] not aabb-framed len=${buf.length} hex=${buf.toString('hex')}`)
                return
            }
            const body = buf.subarray(2, buf.length - 2)

            if (body.length !== 56) {
                console.log(`[DRYER ${thinq.id}] undecoded body len=${body.length} hex=${body.toString('hex')}`)
                return
            }

            // 마지막 27바이트가 최신 상태 블록 (선행 패딩 1 + 마커 0x19 + 실데이터 25바이트)
            const payload = body.subarray(body.length - 27)

            this.parsePayload(payload)
        })
    }

    parsePayload(payload: Buffer) {
        const stateCode = payload[2]
        // 2026-08-27 정정: payload[3],[4]가 실제 "남은시간"(1분마다 감소),
        // payload[5],[6]이 "예정 총 소요시간"(코스 시작 직후 고정) - 기존 이름과 반대였음
        const remainHour = payload[3]
        const remainMinute = payload[4]
        const initialHour = payload[5]
        const initialMinute = payload[6]
        const courseCode = payload[7]
        const dryLevelCode = payload[9]
        const ecoHybridCode = payload[10]
        const processStateCode = payload[11]
        const antiCrease = (payload[16] & 0x02) !== 0
        const smartCare = (payload[17] & 0x20) !== 0

        const remainMinutes = remainHour * 60 + remainMinute
        const initialMinutes = initialHour * 60 + initialMinute

        this.publishProperty('state', STATE_CODES[stateCode] ?? `unknown_0x${stateCode.toString(16)}`)
        this.publishProperty('course', COURSE_CODES[courseCode] ?? `unknown_0x${courseCode.toString(16)}`)
        this.publishProperty('remaining_time', remainMinutes)
        this.publishProperty('initial_time', initialMinutes)
        this.publishProperty('process_state', PROCESS_STATE_CODES[processStateCode] ?? `unknown_0x${processStateCode.toString(16)}`)
        this.publishProperty('dry_level', DRY_LEVEL_CODES[dryLevelCode] ?? `unknown_0x${dryLevelCode.toString(16)}`)
        this.publishProperty('eco_hybrid', ECO_HYBRID_CODES[ecoHybridCode] ?? `unknown_0x${ecoHybridCode.toString(16)}`)
        this.publishProperty('anti_crease', antiCrease ? 'ON' : 'OFF')
        this.publishProperty('smart_care', smartCare ? 'ON' : 'OFF')
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return
        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        // 상태조회 전용 - 제어는 구현하지 않음
    }
}