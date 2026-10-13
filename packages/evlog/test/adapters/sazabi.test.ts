import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSazabiDrain,
  sendBatchToSazabi,
  sendToSazabi,
  toSazabiOTLPConfig,
  toSazabiOTLPEndpoint,
} from '../../src/adapters/sazabi'
import type { OTLPExportLogsRequest } from '../../src/adapters/otlp'
import { getFetchCall, getFetchHeaders, getFetchJson, mockFetch } from '../helpers/fetch'
import { makeContext, makeWideEvent } from '../helpers/events'

const INTAKE_URL = 'https://0123456789abcdef0123456789abcdef.us-west-2.intake.sazabi.com'
const ENV_KEYS = ['NUXT_SAZABI_INTAKE_URL', 'SAZABI_INTAKE_URL', 'NUXT_SAZABI_SERVICE_NAME', 'SAZABI_SERVICE_NAME', 'OTEL_SERVICE_NAME'] as const

describe('sazabi adapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

  beforeEach(() => {
    fetchSpy = mockFetch()
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  describe('toSazabiOTLPEndpoint', () => {
    it('keeps a bare intake URL', () => {
      expect(toSazabiOTLPEndpoint(INTAKE_URL)).toBe(INTAKE_URL)
    })

    it('strips trailing slashes', () => {
      expect(toSazabiOTLPEndpoint(`${INTAKE_URL}//`)).toBe(INTAKE_URL)
    })

    it('strips a pasted /v1/logs suffix', () => {
      expect(toSazabiOTLPEndpoint(`${INTAKE_URL}/v1/logs`)).toBe(INTAKE_URL)
      expect(toSazabiOTLPEndpoint(`${INTAKE_URL}/v1/logs/`)).toBe(INTAKE_URL)
    })
  })

  describe('toSazabiOTLPConfig', () => {
    it('maps to OTLP without auth headers, since the key is in the intake URL', () => {
      const otlp = toSazabiOTLPConfig({ endpoint: `${INTAKE_URL}/`, serviceName: 'api', timeout: 1000, retries: 1 })
      expect(otlp).toEqual({
        endpoint: INTAKE_URL,
        serviceName: 'api',
        resourceAttributes: undefined,
        timeout: 1000,
        retries: 1,
      })
      expect(otlp.headers).toBeUndefined()
    })
  })

  describe('sendToSazabi', () => {
    it('posts OTLP JSON to <intake URL>/v1/logs', async () => {
      await sendToSazabi(makeWideEvent(), { endpoint: INTAKE_URL })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const { url, init } = getFetchCall(fetchSpy)
      expect(url).toBe(`${INTAKE_URL}/v1/logs`)
      expect(init.method).toBe('POST')
      expect(getFetchHeaders(fetchSpy)['Content-Type']).toBe('application/json')
    })

    it('does not post to /v1/logs/v1/logs when the full logs URL is configured', async () => {
      await sendToSazabi(makeWideEvent(), { endpoint: `${INTAKE_URL}/v1/logs` })

      expect(getFetchCall(fetchSpy).url).toBe(`${INTAKE_URL}/v1/logs`)
    })

    it('sends no authorization header', async () => {
      await sendToSazabi(makeWideEvent(), { endpoint: INTAKE_URL })

      const headers = getFetchHeaders(fetchSpy)
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('authorization')
    })

    it('sends an OTLP resourceLogs payload with the service name and event fields', async () => {
      await sendToSazabi(makeWideEvent({ service: 'checkout', level: 'error', path: '/api/pay', status: 500 }), {
        endpoint: INTAKE_URL,
        resourceAttributes: { 'deployment.region': 'us-west-2' },
      })

      const body = getFetchJson<OTLPExportLogsRequest>(fetchSpy)
      const resource = body.resourceLogs[0]!.resource.attributes
      expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'checkout' } })
      expect(resource).toContainEqual({ key: 'deployment.region', value: { stringValue: 'us-west-2' } })
      const record = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
      expect(record.severityText).toBe('ERROR')
      expect(JSON.stringify(record.attributes)).toContain('/api/pay')
    })
  })

  describe('sendBatchToSazabi', () => {
    it('sends every event in one request', async () => {
      await sendBatchToSazabi([makeWideEvent({ requestId: 'a' }), makeWideEvent({ requestId: 'b' })], { endpoint: INTAKE_URL })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const body = getFetchJson<OTLPExportLogsRequest>(fetchSpy)
      expect(body.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2)
    })

    it('skips fetch for an empty batch', async () => {
      await sendBatchToSazabi([], { endpoint: INTAKE_URL })

      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('createSazabiDrain', () => {
    it('posts events with an explicit endpoint', async () => {
      await createSazabiDrain({ endpoint: INTAKE_URL })(makeContext(makeWideEvent()))

      expect(getFetchCall(fetchSpy).url).toBe(`${INTAKE_URL}/v1/logs`)
    })

    it('reads SAZABI_INTAKE_URL and SAZABI_SERVICE_NAME from the environment', async () => {
      process.env.SAZABI_INTAKE_URL = INTAKE_URL
      process.env.SAZABI_SERVICE_NAME = 'worker'

      await createSazabiDrain()(makeContext(makeWideEvent()))

      expect(getFetchCall(fetchSpy).url).toBe(`${INTAKE_URL}/v1/logs`)
      const resource = getFetchJson<OTLPExportLogsRequest>(fetchSpy).resourceLogs[0]!.resource.attributes
      expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'worker' } })
    })

    it('logs an error and skips fetch when the endpoint is missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await createSazabiDrain()(makeContext(makeWideEvent()))

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[evlog/sazabi] Missing endpoint. Set SAZABI_INTAKE_URL'))
    })

    it('batches multiple contexts into one request', async () => {
      await createSazabiDrain({ endpoint: INTAKE_URL })([makeContext(makeWideEvent()), makeContext(makeWideEvent())])

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(getFetchJson<OTLPExportLogsRequest>(fetchSpy).resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2)
    })
  })
})
