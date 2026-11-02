import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { parseResponse } from '../schemas/parse.js'
import { DownloadLinkSchema, SearchPhotosResponseSchema } from '../schemas/photo.js'
import { UnsplashApiError } from '../unsplash/errors.js'
import { buildAttribution } from './format.js'
import type { ToolContext } from './index.js'
import { toJsonResult, toToolError } from './result.js'

const MAX_PICK = 30
// SSRF guard: image bytes are only ever fetched from Unsplash's image CDN.
const IMAGE_HOST = 'images.unsplash.com'

const slidePhotoInput = {
  query: z.string().trim().min(1).describe('What the slide image should show.'),
  orientation: z
    .enum(['landscape', 'portrait', 'squarish'])
    .default('landscape')
    .describe('Photo orientation. Defaults to landscape for 16:9 slides.'),
  pick: z
    .number()
    .int()
    .min(1)
    .max(MAX_PICK)
    .default(1)
    .describe('Which search result to use, 1-based. Use 2, 3... to get a different photo.'),
  width: z
    .number()
    .int()
    .min(400)
    .max(4000)
    .default(1920)
    .describe('Image width in pixels (1920 suits a 16:9 slide).'),
  save_dir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Optional absolute folder to save the image into, for decks that embed files. ' +
        'Omit to get only the URL.',
    ),
}

/** Slide-sized JPEG URL built from the photo's imgix `raw` base. */
function slideImageUrl(raw: string, width: number): string {
  const url = new URL(raw)
  url.searchParams.set('w', String(width))
  url.searchParams.set('q', '80')
  url.searchParams.set('fm', 'jpg')
  url.searchParams.set('fit', 'max')
  return url.toString()
}

async function saveImage(imageUrl: string, dir: string, id: string, signal: AbortSignal) {
  const url = new URL(imageUrl)
  if (url.protocol !== 'https:' || url.host !== IMAGE_HOST) {
    throw new UnsplashApiError('bad_request', `Refusing to fetch image from host ${url.host}.`)
  }
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new UnsplashApiError('bad_request', `Image download failed (HTTP ${res.status}).`)
  }
  const folder = resolve(dir)
  await mkdir(folder, { recursive: true })
  const path = join(folder, `unsplash-${id}.jpg`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

/** Register the one-call slide tool. */
export function registerSlideTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'unsplash_slide_photo',
    {
      title: 'Unsplash Photo for a Slide',
      description:
        'One call for slide decks: searches Unsplash, takes the Nth result, registers the ' +
        'download (required by Unsplash guidelines), and returns a slide-sized image URL, the ' +
        'credit line to put on the slide, and the photo page link. Optionally saves the image ' +
        'to a folder. Use this instead of search + track_download. Counts as a real download, ' +
        'so call it only for a photo that will actually be used.',
      inputSchema: slidePhotoInput,
      // Registers a download (non-destructive side effect), optionally writes a file.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const search = await ctx.client.get('/search/photos', {
          params: {
            query: args.query,
            orientation: args.orientation,
            per_page: args.pick,
            content_filter: 'high',
          },
          signal: extra.signal,
        })
        const parsed = parseResponse(SearchPhotosResponseSchema, search.data, 'slide search')
        const photo = parsed.results[args.pick - 1]
        if (!photo) {
          throw new UnsplashApiError(
            'not_found',
            `No result #${args.pick} for "${args.query}" (found ${parsed.results.length}).`,
          )
        }
        const raw = photo.urls?.raw
        const downloadLocation = photo.links?.download_location
        if (!raw || !downloadLocation) {
          throw new UnsplashApiError('bad_request', 'Photo is missing image or download links.')
        }

        // Download tracking: the path is taken from a photo we just fetched from Unsplash.
        const location = new URL(downloadLocation)
        if (location.protocol !== 'https:' || location.host !== 'api.unsplash.com') {
          throw new UnsplashApiError('bad_request', 'Unexpected download_location host.')
        }
        const tracked = await ctx.client.get(location.pathname + location.search, {
          signal: extra.signal,
        })
        parseResponse(DownloadLinkSchema, tracked.data, 'track download')

        const imageUrl = slideImageUrl(raw, args.width)
        const savedTo = args.save_dir
          ? await saveImage(imageUrl, args.save_dir, photo.id, extra.signal)
          : undefined
        const attribution = buildAttribution(photo, ctx.config.appName)

        return toJsonResult({
          id: photo.id,
          description: photo.description ?? photo.alt_description ?? null,
          image_url: imageUrl,
          saved_to: savedTo ?? null,
          credit_text: attribution.text,
          credit_html: attribution.html,
          photo_page: photo.links?.html,
          download_tracked: true,
          rate_limit: tracked.rateLimit,
        })
      } catch (error) {
        return toToolError(error, ctx.redact)
      }
    },
  )
}
