import { Request, Response, Router } from 'express'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import { injectStatus } from './device'

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

// diagMonData 내부의 <lgedmRoot><eventMonitoring><monData>...</monData></eventMonitoring></lgedmRoot>
// XML을 풀 때 재사용. 최상위 xmlParser 미들웨어와 별개로, diagmon 바디 안에
// "한 번 더" 인코딩되어 들어있는 XML 문자열을 파싱하기 위한 용도.
const innerXmlParser = new XMLParser()

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

export function routes(config: Config) {
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

    // 기기가 poll(Mon/Start) 없이도 스스로 상태 변화를 올리는 채널.
    // 캡처로 확인된 실제 바디 구조:
    //   <Report>
    //     <devId>...</devId>
    //     ...
    //     <diagMonType>EventMonitoring</diagMonType>
    //     <diagMonData>BASE64( <lgedmRoot><eventMonitoring><monData>BASE64(12바이트 상태)</monData>...</eventMonitoring></lgedmRoot> )</diagMonData>
    //   </Report>
    // 응답은 기기가 지연에 민감할 수 있으니 파싱 전에 먼저 즉시 res.end() 한다.
    // diagMonType이 'EventMonitoring'이 아니거나 monData가 없는 경우
    // (예: 실제 캡처에서 관측된, 12바이트가 아닌 정체불명의 진단 프레임)는
    // 그냥 조용히 무시한다 - 상태 반영과 무관한 데이터로 보인다.
    router.post('/lgehadm/report/diagmon', (req, res) => {
        res.end()

        try {
            const report = req.body?.Report
            const devId: string | undefined = report?.devId
            const diagMonDataB64: unknown = report?.diagMonData

            if (!devId || typeof diagMonDataB64 !== 'string') return

            // 1단계 base64 디코드: <lgedmRoot><eventMonitoring><monData>...</monData>...
            const innerXml = Buffer.from(diagMonDataB64, 'base64').toString('utf-8')
            const inner = innerXmlParser.parse(innerXml)
            const monDataB64: unknown = inner?.lgedmRoot?.eventMonitoring?.monData

            if (typeof monDataB64 !== 'string') return

            // 2단계 base64 디코드: 실제 상태 버퍼. SOCKET Mon/Start 응답
            // (Body.Format==='B64' && Body.Data)과 동일한 포맷이라, 각 기기
            // 핸들러의 thinq.on('data', buf) 로직을 그대로 재사용할 수 있다.
            const stateBuf = Buffer.from(monDataB64, 'base64')

            injectStatus(devId, stateBuf)
        } catch (err) {
            // diagmon은 기기 자체 진단 채널이라 알 수 없는 포맷이 섞여 들어올 수
            // 있으므로, 파싱 실패로 서버가 죽지 않게 조용히 로그만 남긴다.
            console.log('[diagmon] parse error', err)
        }
    })

    return router
}
