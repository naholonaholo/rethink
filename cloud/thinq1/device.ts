import { TypedEmitter } from 'tiny-typed-emitter'
import { Duplex } from 'node:stream'
import { Connection } from './connection'
import { getDeviceMetadata } from './http'
import { Metadata } from '../thinq'
import { randomUUID } from 'node:crypto'
import { registerDevice, unregisterDevice } from './status-bridge'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    data: (packet: Buffer) => void
    sendData: (body: object) => void
    close: () => void
}

export class Device extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq1'

    lastReport: Buffer | undefined

    constructor(
        readonly con: ConWithExtra,
        readonly id: string,
        readonly meta: Metadata,
    ) {
        super()
        con.deviceObj = this
        // HTTPS diagmon 쪽(http.ts → status-bridge.ts)에서 이 기기를 찾아
        // 상태를 주입할 수 있도록 등록. device.ts는 http.ts를 그대로
        // import하지만(getDeviceMetadata), http.ts는 device.ts를 직접
        // import하지 않고 status-bridge.ts를 통해서만 접근하므로 순환
        // 참조가 생기지 않는다.
        registerDevice(id, this)
        con.on('status', (packet) => {
            this.lastReport = packet
            this.emit('data', packet)
        })
        con.on('error', console.log)
        con.on('close', () => {
            if (con.deviceObj === this) {
                this.emit('close')
                con.deviceObj = undefined
            }
            unregisterDevice(id, this)
        })
    }

    send(body: object) {
        this.emit('sendData', body)
        this.con.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`,
            },
        })
    }
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void
    dropDevice: (id: string) => void
}

export class DeviceAcceptor extends TypedEmitter<DeviceAcceptorEvents> {
    connectionsById: Record<string, Connection> = {}
    constructor() {
        super()
    }

    accept(socket: Duplex) {
        const con = new Connection(socket) as ConWithExtra
        con.on('error', () => {}) // ignore errors at this stage
        con.on('init', (deviceId) => {
            console.log('here', deviceId)
            const meta = getDeviceMetadata(deviceId)
            if (!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`)
                con.destroy()
                return
            }

            if (this.connectionsById[deviceId]) {
                console.warn(`device ${deviceId} already connected, dropping the old one`)
                this.connectionsById[deviceId].destroy()
            }

            this.connectionsById[deviceId] = con

            con.on('close', () => {
                if (this.connectionsById[deviceId] === con) {
                    delete this.connectionsById[deviceId]
                    this.emit('dropDevice', deviceId)
                }
            })
            con.removeAllListeners('error')

            const dev = new Device(con, deviceId, meta)
            this.emit('newDevice', dev)
        })
    }
}
