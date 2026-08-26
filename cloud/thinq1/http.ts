import { Request, Response, Router } from 'express'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import { DeviceAcceptor, type ConWithExtra } from './device'
import log from '@/util/logging'

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

const deviceMeta: Record<string, Metadata> = {}
export function getDeviceMetadata(id: string) {
    return deviceMeta[id]
}

function xmlParser(req: Request, res: Response, next: () => void) {
    const buffers: Buffer[] = []
    let length = 0
    let error = false

    req.on('data', (data) => {
        if (!error) {
            buffers.push(data)
            length += data.length
            if (length > 1000000) {
                res.status(400).end()
                error = true
            }
        }
    })

    req.on('end', () => {
        if (!error) {
            req.body = new XMLParser().parse(Buffer.concat(buffers))
            next()
        }
    })
}

export function routes(config: Config, acceptor: DeviceAcceptor) {
    const router = Router()
    router.use(xmlParser)

    router.post('/lgehadm/api/Device/TotalDeviceInfoSvc', (req, res) => {
        const response: any = {
            returnCd: '0000',
            returnMsg: 'OK',
        }

        const deviceId = req.header('x-lgedm-deviceid')
        const deviceType = req.header('x-lgedm-devicetype')
        const modelName = req.body?.lgedmRoot?.modelName
        if (!deviceId) return res.status(400).end()

        if (modelName && deviceType)
            deviceMeta[deviceId] = {
                deviceType,
                modelId: modelName,
                modelName,
            }

        if (req.body?.lgedmRoot?.itemList?.item === 'DM_SETTING_INFO_GET_URI') {
            response.itemList = {
                elementList: {
                    elementCode: 'settingInfoList',
                    elementValueList: {
                        code: 'BlackBox',
                        value: 'N',
                    },
                },
                item: 'DM_SETTING_INFO_GET_URI',
                returnCode: '0000',
            }
        } else if (req.body?.lgedmRoot?.itemList?.item === 'THINQ_TIME_SYNC_URI') {
            response.itemList = {
                elementList: [
                    {
                        elementCode: 'utcTime',
                        elementValue: new Date()
                            .toISOString()
                            .replace(/T|\....Z/g, ' ')
                            .trim(),
                    },
                    {
                        elementCode: 'timezone',
                        elementValue: 0,
                    },
                ],
                item: 'THINQ_TIME_SYNC_URI',
                returnCode: '0000',
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: response }))
    })

    router.post('/lgehadm/api/Grid/PowerSavingInfoSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0108', returnMsg: 'No Saving Data.' } }))
    })

    router.post('/lgehadm/api/Rtos/FWInfoSettingSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    // 기기가 상태 변화 시 스스로(poll 없이, 1.5초 내) 올리는 이벤트 리포트.
    // 2026-08-25 캡처로 발견: 바디는 <Report><devId>..<diagMonData>BASE64(
    //   <lgedmRoot><eventMonitoring><monData>BASE64(12바이트 상태)</monData>...)
    // </diagMonData></Report> 형태의 이중 base64 구조.
    // monData를 디코드하면 SOCKET Mon/Start 응답과 완전히 동일한 12바이트 포맷이라,
    // 그대로 Device의 'data' 이벤트로 흘려보내면 기존 기기 핸들러(예: 냉장고)가
    // 수정 없이 그대로 처리한다 (Mon 응답이든 diagmon push든 구분하지 않음).
    router.post('/lgehadm/report/diagmon', (req, res) => {
        try {
            const devId: string | undefined = req.body?.Report?.devId
            const diagMonType: string | undefined = req.body?.Report?.diagMonType
            const diagMonDataB64: string | undefined = req.body?.Report?.diagMonData

            if (devId && diagMonType === 'EventMonitoring' && typeof diagMonDataB64 === 'string') {
                const innerXml = Buffer.from(diagMonDataB64, 'base64').toString('utf-8')
                const inner = new XMLParser().parse(innerXml)
                const monDataB64 = inner?.lgedmRoot?.eventMonitoring?.monData

                if (typeof monDataB64 === 'string') {
                    const monData = Buffer.from(monDataB64, 'base64')
                    const con = acceptor.connectionsById[devId] as ConWithExtra | undefined
                    const dev = con?.deviceObj

                    if (dev) {
                        dev.emit('data', monData)
                    } else {
                        log('status', `diagmon: ${devId} 활성 연결 없음, 무시`)
                    }
                }
            }
        } catch (err) {
            log('status', 'diagmon 파싱 실패:', String(err))
        }

        res.end()
    })

    return router
}
