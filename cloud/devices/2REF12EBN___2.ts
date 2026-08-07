import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { Metadata } from '../thinq'

export default class Device extends HADevice {
    private pollTimer?: NodeJS.Timeout

    constructor(HA: Connection, readonly thinq: Thinq1Device, meta: Metadata) {
        super(HA, thinq.id)
        this.setConfig(HADevice.config(meta, { name: 'LG Refrigerator (캡처중)' }))
        thinq.on('data', (buf) => {
            console.log('RAW:', buf.length, 'bytes ->', buf.toString('hex'))
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })

        this.pollTimer = setInterval(() => {
            console.log('[poll] requesting data...')
            this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Data' })
        }, 3000)
    }
}