// cloud/devices/S5MPC.ts
// LG 스타일러 (S5MPC) - 상태조회 전용 핸들러
// thinq2 프로토콜: 기기가 상태 변화마다 스스로 aabb 프레임을 push하므로
// 별도 폴링(Mon Start 등) 없이 thinq.on('data', ...)만으로 충분함.
// 원격제어(Control)는 구현하지 않음 - 상태조회(코스/남은시간/상태/에러)만 목적.
//
// 2026-08-28 전체 사이클(급속 코스, 20분) 캡처로 상태코드 보강:
//   idle(0x01) -> presteam(0x32) -> steam1(0x34) -> steam2(0x36)
//   -> drying(0x37, 가장 긴 구간) -> cooling(0x38) -> finishing(0x04) -> off(0x00)
//   payload[7]이 매번 "직전 상태 코드"를 그대로 담고 있어 순서를 교차검증함.
//   각 단계 한글 명칭은 미확정 - 추후 디스플레이 문구 대조 시 수정 가능.
//
// 2026-08-28 remaining_time 버그 수정:
//   기존 코드는 payload[3]/payload[4](총 소요시간, 시작 후 고정값)를 읽고 있어서
//   화면상 "남은시간"이 절대 줄지 않는 문제가 있었음. 실제 매분 1씩 감소하는
//   카운트다운 값은 payload[2]인 것으로 확인 (20분 코스에서 20->19->...->1까지
//   실제 시계와 1분 단위로 정확히 일치 검증됨).

import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

const STATE_CODES: Record<number, string> = {
    0x00: 'off',
    0x01: 'idle',
    0x03: 'paused',
    0x32: 'presteam',
    0x34: 'steam1',
    0x36: 'steam2',
    0x37: 'drying',
    0x38: 'cooling',
    0x04: 'finishing',
    0x05: 'error',
}

const COURSE_CODES: Record<number, string> = {
    0x00: '없음',
    0x01: '스타일링 표준',
    0x03: '스타일링 급속',
    0x05: '스타일링 강력',
    0x06: '고급의류 울/니트',
    0x07: '고급의류 정장/코트',
    0x08: '고급의류 기능성',
    0x0a: '고급의류 다운로드코스',
    0x0b: '스팀살균 표준',
    0x0c: '스팀살균 침구',
    0x0f: '섬세건조 자동건조',
    0x12: '섬세건조 시간건조',
    0x17: '섬세건조 실내제습(2시간)',
    0x18: '섬세건조 실내제습(4시간)',
    0x1e: '스팀살균 미세먼지',
    0x1f: '스팀살균 바이러스',
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
                ...HADevice.config(meta, { name: 'LG Styler' }),
                components: {
                    state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-state',
                        state_topic: '$this/state',
                        name: 'State',
                        icon: 'mdi:hanger',
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
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            // 원본은 aa + len(1) + body + checksum(1) + bb 로 감싸져 있음 (aabb 프로토콜 프레이밍)
            // 우리가 필요한 건 그 안의 body이므로 앞뒤 2바이트씩 벗겨냄
            if (buf.length < 4 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) {
                console.log(`[STYLER ${thinq.id}] not aabb-framed len=${buf.length} hex=${buf.toString('hex')}`)
                return
            }
            const body = buf.subarray(2, buf.length - 2)

            if (body.length !== 60) {
                console.log(`[STYLER ${thinq.id}] undecoded body len=${body.length} hex=${body.toString('hex')}`)
                return
            }

            const rest = body.subarray(3) // 57바이트
            const afterBlock = rest.subarray(29) // 28바이트 (0x1b + 27바이트 payload)
            const payload = afterBlock.subarray(1) // 27바이트 실 데이터

            if (payload.length !== 27) {
                console.log(`[STYLER ${thinq.id}] unexpected payload len=${payload.length} hex=${payload.toString('hex')}`)
                return
            }

            this.parsePayload(payload)
        })
    }

    parsePayload(payload: Buffer) {
        const stateCode = payload[0]
        const remainMinute = payload[2] // 실측 카운트다운 필드 (2026-08-28 확정)
        const courseCode = payload[5]
        const errorCode = payload[6]

        this.publishProperty('state', STATE_CODES[stateCode] ?? `unknown_0x${stateCode.toString(16)}`)
        this.publishProperty('course', COURSE_CODES[courseCode] ?? `unknown_0x${courseCode.toString(16)}`)
        this.publishProperty('remaining_time', remainMinute)
        this.publishProperty('error', errorCode !== 0 ? 'ON' : 'OFF')
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