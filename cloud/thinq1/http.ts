import { Request, Response, Router } from 'express'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import { injectStatus } from './status-bridge'

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

// 실제 LG 클라우드(kic.lgthinq.com)가 DM_SETTING_INFO_GET_URI에 응답할 때 보내는
// pushDetailSettingList 값을 그대로 캡처해서 재사용한다 (2026-08-25 relay 캡처로 확인).
// 기기는 이 목록에서 "코드:Y"로 표시된 이벤트에 한해 diagmon(EventMonitoring)을
// 통해 poll 없이 상태를 push한다. 이 항목 자체가 응답에서 빠지면(예전 코드처럼)
// 기기가 push를 켜지 않고 기존 Mon/Start 폴링에만 응답하게 된다.
const PUSH_DETAIL_ALL_ENABLED =
    '0001:Y,0002:Y,0003:Y,0004:Y,0005:Y,0006:Y,0007:Y,0008:Y,0009:Y,0010:Y,0011:Y,0012:Y,0013:Y,0014:Y,0015:Y,0016:Y,0017:Y,0018:Y,0019:Y,0020:Y,0021:Y,0022:Y,0023:Y,0024:Y,0025:Y,0026:Y,0027:Y,0028:Y,0029:Y,0030:Y,0031:Y,0032:Y,0033:Y,0034:Y,0035:Y,0036:Y,0037:Y,0038:Y,0039:Y,0040:Y,0041:Y,0042:Y,0043:Y,0047:Y,0048:Y,0049:Y,0050:Y,0051:Y,0052:Y,0053:Y,0054:Y,0055:Y,0056:Y,0057:Y,0058:Y,0059:Y,0060:Y,0061:Y,0062:Y,0063:Y,0064:Y,0065:Y,0066:Y,0067:Y,0070:Y,0071:Y,0072:Y,0073:Y,0074:Y,0075:Y,0076:Y,0077:Y,9102:Y,9103:Y,9104:Y,9105:Y,9106:Y,9107:Y,9109:Y,9110:Y,9111:Y,9901:Y,P056:Y,P057:Y,RE01:Y,RE02:Y,RE03:Y,RE04:Y,RE05:Y,RE06:Y,RE07:Y,RE08:Y,RE09:Y,RE10:Y,RE11:Y,RE12:Y,RE13:Y'

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
                // elementList가 배열이어야 settingInfoList / pushDetailSettingList가
                // 각각 별도의 <elementList> 태그로 나간다 (실제 서버 응답과 동일 구조).
                elementList: [
                    {
                        elementCode: 'settingInfoList',
                        elementValueList: [
                            { code: 'Area', value: '0' },
                            { code: 'BlackBox', value: 'Y' },
                        ],
                    },
                    {
                        // 이게 diagmon(EventMonitoring) push를 켜는 핵심 항목.
                        // 빠지면 기기가 push를 안 하고 Mon/Start 폴링에만 응답한다.
                        elementCode: 'pushDetailSettingList',
                        elementValueList: {
                            code: 'PushDetail',
                            value: PUSH_DETAIL_ALL_ENABLED,
                        },
                    },
                ],
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
