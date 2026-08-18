import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { Metadata } from '../thinq'

// status(byte0) 코드 — 실측 패킷 캡처로 확인 (2026-08-17)
const STATES: Record<number, string> = {
    0x00: 'off',
    0x05: 'course_select',
    0x06: 'paused',
    0x14: 'starting',
    0x15: 'paused_add_laundry',
    0x17: 'washing',
    0x1e: 'rinsing',
    0x28: 'spinning',
    0x3c: 'finished',
}

// course(byte5) 코드 — 다이얼 물리적 순서와 1:1 확인됨
const COURSES: Record<number, string> = {
    1: '스피드워시',
    2: '아기옷',
    3: '조용조용',
    4: '알뜰삶음',
    5: '찌든때',
    6: '표준세탁',
    7: '기능성의류',
    8: '컬러케어',
    9: '란제리/울',
    10: '이불',
    11: '헹굼+탈수',
    12: '다운로드코스',
}

// spin(byte8) 코드
const SPINS: Record<number, string> = {
    0: '없음',
    1: '섬세',
    2: '약',
    3: '중',
    4: '강',
    5: '건조맞춤',
}

// temp(byte9) 코드
const TEMPS: Record<number, string> = {
    1: '냉수',
    2: '30',
    3: '40',
    4: '60',
    5: '95',
}

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig({
            ...HADevice.config(meta, { name: 'LG Washer' }),
            components: {
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Status',
                    icon: 'mdi:state-machine',
                    device_class: 'enum',
                    options: Object.values(STATES),
                },
                course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    name: 'Course',
                    icon: 'mdi:pin-outline',
                },
                spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin',
                    state_topic: '$this/spin',
                    name: 'Spin',
                    icon: 'mdi:autorenew',
                },
                temp: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp',
                    state_topic: '$this/temp',
                    name: 'Water temperature',
                    icon: 'mdi:thermometer',
                },
                rinse_count: {
                    platform: 'sensor',
                    unique_id: '$deviceid-rinse_count',
                    state_topic: '$this/rinse_count',
                    name: 'Rinse count',
                    icon: 'mdi:water-sync',
                },
                initial_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-initial_time',
                    state_topic: '$this/initial_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Initial time',
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time',
                },
            },
        })

        thinq.on('data', (buf) => {
            if (buf.length !== 25) return

            const status = buf[0]
            const remainMin = buf[2]
            const initialMin = buf[4]
            const course = buf[5]
            const spin = buf[8]
            const temp = buf[9]
            const rinseCount = buf[10]

            this.publishProperty('status', STATES[status] ?? 'unknown')
            this.publishProperty('course', COURSES[course] ?? 'unknown')
            this.publishProperty('spin', SPINS[spin] ?? 'unknown')
            this.publishProperty('temp', TEMPS[temp] ?? 'unknown')
            this.publishProperty('rinse_count', rinseCount)
            this.publishProperty('initial_time', initialMin)
            this.publishProperty('remaining_time', remainMin)
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return
        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        // read-only 목적이라 제어 명령은 구현하지 않음
    }
}