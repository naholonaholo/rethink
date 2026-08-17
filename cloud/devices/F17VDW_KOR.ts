// cloud/devices/F17VDW_KOR.ts
// LG 트롬 드럼세탁기 (F17VDW_KOR) — 임시 진단용 캡처 핸들러
// 목적: raw 상태 패킷을 콘솔에 hex로 dump해서 코스/남은시간 등의 바이트 오프셋을 특정하기 위함
// 제어(Control)는 아직 구현하지 않음 — 상태조회 오프셋 확정 후 별도 작업

import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { Metadata } from '../thinq'

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)

        // HA 엔티티는 최소한만 (availability 정도) — 진단 단계라 컴포넌트 없이 등록만
        this.setConfig(HADevice.config(meta, { name: 'LG Washer (debug capture)' }))

        thinq.on('data', (buf) => {
            console.log(
                `[F17VDW-CAPTURE ${thinq.id}] len=${buf.length} hex=${buf.toString('hex')}`,
            )

            // WTDN3(다른 세탁기 모델)와 같은 28바이트 구조인지 참고용으로 같이 찍어봄
            // 구조가 다르면 이 줄의 값들은 무의미하니 hex 원본을 기준으로 판단할 것
            if (buf.length === 28) {
                console.log(
                    `  [as WTDN3-guess] status=${buf[0]} time_remain=${buf[1]}:${buf[2]} time_init=${buf[3]}:${buf[4]} native_course=${buf[5]} error=${buf[6]} spin=${buf[8]} temp=${buf[9]} drying=${buf[11]} lock=${buf[15]} custom_course=${buf[20]} cycles=${buf[21]}`,
                )
            }
        })
    }

    start() {
        // 반복 전송(setInterval) 제거 — 세션 리셋으로 인한 방해 가능성 테스트
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    setProperty(prop: string, mqttValue: string) {
        // 진단 단계라 제어는 아직 구현하지 않음
    }
}