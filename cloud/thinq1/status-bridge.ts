// thinq1/device.ts 와 thinq1/http.ts 양쪽에서 공유하는 상태 브릿지.
// 두 파일이 서로를 직접 import하면 순환 참조가 생기므로, 그 사이에 끼워
// 넣는 중립 모듈로 분리했다. device.ts만 등록/해제(registerDevice/
// unregisterDevice)를 호출하고, http.ts만 조회(injectStatus)를 호출한다.

type StatusReceiver = {
    lastReport: Buffer | undefined
    emit(event: 'data', packet: Buffer): void
}

const devicesById: Record<string, StatusReceiver> = {}

export function registerDevice(id: string, dev: StatusReceiver) {
    devicesById[id] = dev
}

export function unregisterDevice(id: string, dev: StatusReceiver) {
    if (devicesById[id] === dev) {
        delete devicesById[id]
    }
}

// http.ts의 diagmon 라우트에서, 이중 base64를 풀어 얻은 12바이트 상태 버퍼를
// 넘겨받아 해당 기기의 'data' 이벤트로 emit한다. 각 기기 핸들러(예: fridge)의
// thinq.on('data', ...) 로직을 그대로 재사용하기 위해 SOCKET 'status' 응답과
// 완전히 동일한 이벤트/포맷으로 통일한다.
export function injectStatus(deviceId: string, packet: Buffer) {
    const dev = devicesById[deviceId]
    if (!dev) {
        console.log(`[thinq1] injectStatus: unknown device ${deviceId} (아직 SOCKET으로 연결/등록되지 않음)`)
        return
    }
    dev.lastReport = packet
    dev.emit('data', packet)
}
