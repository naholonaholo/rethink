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

        // HA 엔티티는 필요없으니 최소한만 (availability 정도)
        this.setConfig(HADevice.config(meta, { name: 'LG Fridge (debug capture)' }))

        thinq.on('data', (buf) => {
            console.log(
                `[FRIDGE-CAPTURE ${thinq.id}] len=${buf.length} hex=${buf.toString('hex')}`,
            )
        })
    }

    monTimer: ReturnType<typeof setInterval> | undefined

    start() {
        // WTDN3와 동일한 방식으로 폴링을 강제 시작
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })

        // 세션이 만료될 가능성에 대비해 주기적으로 재전송
        this.monTimer = setInterval(() => {
            this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
        }, 10_000)
    }

    setProperty(prop: string, mqttValue: string) {
        // 진단 단계라 제어는 구현하지 않음
    }
}