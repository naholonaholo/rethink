import { TypedEmitter } from 'tiny-typed-emitter'
import { Duplex } from 'node:stream'
import { Connection } from './connection'
import { getDeviceMetadata } from './http'
import { Metadata } from '../thinq'
import { randomUUID } from 'node:crypto'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    data: (packet: Buffer) => void
    sendData: (body: object) => void
    close: () => void
}

// HTTPS 쪽(diagmon 등, http.ts 참고)에서 SOCKET 연결과 무관하게 deviceId만으로
// 해당 기기에 상태를 주입할 수 있도록 하는 레지스트리.
// 기기가 poll(Mon/Start) 없이도 스스로 상태 변화를 올리는 diagmon 이벤트를,
// 기존 SOCKET 'status' 이벤트와 동일한 'data' 이벤트로 흘려보내기 위해 사용한다.
const devicesById: Record<string, Device> = {}

// http.ts의 diagmon 라우트에서 이중 base64를 풀어 얻은 12바이트 상태 버퍼를
// 넘겨받아, 해당 기기의 'data' 이벤트로 emit한다. 각 기기 핸들러
// (예: fridge)의 thinq.on('data', ...) 로직을 그대로 재사용하기 위해
// SOCKET 'status' 응답과 완전히 동일한 포맷/이벤트로 통일한다.
export function injectStatus(deviceId: string, packet: Buffer) {
    const dev = devicesById[deviceId]
    if (!dev) {
        console.log(`[thinq1] injectStatus: unknown device ${deviceId} (아직 SOCKET으로 연결/등록되지 않음)`)
        return
    }
    dev.lastReport = packet
    dev.emit('data', packet)
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
        devicesById[id] = this
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
            if (devicesById[id] === this) {
                delete devicesById[id]
            }
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
