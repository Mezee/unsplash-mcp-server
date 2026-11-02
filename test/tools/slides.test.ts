import { describe, expect, it } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { connect, fakeFetchDetailed, jsonResponse, parseResult } from '../helpers/mcp.js'

const photo = {
  id: 'abc123',
  alt_description: 'a city at night',
  width: 6000,
  height: 4000,
  urls: { raw: 'https://images.unsplash.com/photo-1?ixid=xyz', full: 'f', regular: 'g' },
  links: {
    html: 'https://unsplash.com/photos/abc123',
    download_location: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
  },
  user: { username: 'janedoe', name: 'Jane Doe', links: { html: 'https://unsplash.com/@janedoe' } },
}

function responder(results: unknown[]) {
  return (): Response => jsonResponse({ total: results.length, total_pages: 1, results })
}

describe('unsplash_slide_photo', () => {
  it('searches, tracks the download, and returns image url + credit', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input))
      if (String(input).includes('/download'))
        return jsonResponse({ url: 'https://images.unsplash.com/photo-1' })
      return jsonResponse({ total: 1, total_pages: 1, results: [photo] })
    }) as unknown as typeof fetch
    const client = await connect(fetchImpl)
    const res = await client.callTool({
      name: 'unsplash_slide_photo',
      arguments: { query: 'city night' },
    })
    const data = parseResult(res as CallToolResult) as Record<string, unknown>
    expect(String(data.image_url)).toContain('w=1920')
    expect(data.credit_text).toBe('Photo by Jane Doe on Unsplash')
    expect(data.download_tracked).toBe(true)
    expect(urls.some((u) => u.includes('/photos/abc123/download'))).toBe(true)
  })

  it('errors when the requested pick has no result', async () => {
    const { fn } = fakeFetchDetailed(responder([]))
    const client = await connect(fn)
    const res = await client.callTool({ name: 'unsplash_slide_photo', arguments: { query: 'zzz' } })
    expect((res as { isError?: boolean }).isError).toBe(true)
  })
})
