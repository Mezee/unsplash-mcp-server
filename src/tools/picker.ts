import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { parseResponse } from '../schemas/parse.js'
import { SearchPhotosResponseSchema } from '../schemas/photo.js'
import { toCompactPhoto } from './format.js'
import type { ToolContext } from './index.js'
import { toTextResult, toToolError } from './result.js'

const PICKER_URI = 'ui://unsplash/picker.html'
const MCP_APP_MIME = 'text/html;profile=mcp-app'
const CANDIDATES = 3

const pickerInput = {
  query: z.string().trim().min(1).describe('What the slide image should show.'),
  orientation: z
    .enum(['landscape', 'portrait', 'squarish'])
    .default('landscape')
    .describe('Photo orientation. Defaults to landscape for 16:9 slides.'),
  save_dir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional absolute folder the chosen image is saved into.'),
  page: z.number().int().min(1).default(1).describe('Result page, for "show me more".'),
}

/**
 * Self-contained MCP Apps view: shows the candidates, and on click calls
 * `unsplash_slide_photo` through the host. Speaks the MCP Apps postMessage
 * JSON-RPC dialect directly so it needs no bundler or extra dependency.
 */
const PICKER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mute:#6b6b6b;--line:#e3e1dc;--card:#faf9f7}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--fg:#f2f1ee;--mute:#a3a29d;--line:#3d3d3a;--card:#30302e}}
body{margin:0;padding:12px;font:14px -apple-system,system-ui,sans-serif;background:transparent;color:var(--fg)}
.g{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.c{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.c img{width:100%;aspect-ratio:3/2;object-fit:cover;display:block}
.b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex:1}
.n{font-weight:500}.s{color:var(--mute);font-size:12px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:8px;padding:8px 10px;margin-top:auto}
button:hover{background:var(--line)}button:disabled{opacity:.5;cursor:default}
#out{margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);display:none}
#msg{color:var(--mute);padding:8px 0}
</style></head><body>
<div id="msg">Loading candidates…</div><div class="g" id="g"></div><div id="out"></div>
<script>
var nextId=1,pending={},state={query:'',orientation:'landscape',save_dir:undefined,photos:[]};
function send(m){parent.postMessage(m,'*')}
function request(method,params){return new Promise(function(res,rej){var id=nextId++;pending[id]={res:res,rej:rej};send({jsonrpc:'2.0',id:id,method:method,params:params})})}
function notify(method,params){send({jsonrpc:'2.0',method:method,params:params})}
function resize(){notify('ui/notifications/size-changed',{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})}
function short(t){t=(t||'Untitled').replace(/\\s+/g,' ').trim();return t.length>44?t.slice(0,44).replace(/\\s+\\S*$/,'')+'…':t.charAt(0).toUpperCase()+t.slice(1)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function show(result){
  var data=result&&result.structuredContent;
  if(!data&&result&&result.content&&result.content[0]){try{data=JSON.parse(result.content[0].text)}catch(e){}}
  if(!data||!data.photos){document.getElementById('msg').textContent='No candidates returned.';resize();return}
  state=data;document.getElementById('msg').style.display='none';
  var g=document.getElementById('g');g.textContent='';
  data.photos.forEach(function(p){
    var c=el('div','c'),i=el('img');i.src=p.thumb;i.alt=p.description||'Unsplash photo';c.appendChild(i);
    var b=el('div','b');b.appendChild(el('div','n',p.pick+' · '+short(p.description)));
    b.appendChild(el('div','s',p.credit));
    var btn=el('button',null,'Use this one');
    btn.onclick=function(){choose(p,btn)};b.appendChild(btn);c.appendChild(b);g.appendChild(c)});
  resize();
}
function choose(p,btn){
  var all=document.querySelectorAll('button');all.forEach(function(b){b.disabled=true});btn.textContent='Saving…';
  var args={query:state.query,orientation:state.orientation,pick:p.pick+(state.offset||0)};
  if(state.save_dir)args.save_dir=state.save_dir;
  request('tools/call',{name:'unsplash_slide_photo',arguments:args}).then(function(r){
    var d;try{d=JSON.parse(r.content[0].text)}catch(e){}
    var o=document.getElementById('out');o.style.display='block';o.textContent='';
    if(r.isError||!d){o.textContent=(r.content&&r.content[0]&&r.content[0].text)||'Failed.';btn.textContent='Use this one';all.forEach(function(b){b.disabled=false})}
    else{o.appendChild(el('div','n','Saved and download registered'));o.appendChild(el('div','s',d.credit_text));
      if(d.saved_to)o.appendChild(el('div','s',d.saved_to));btn.textContent='Chosen'}
    resize();
  }).catch(function(e){document.getElementById('out').style.display='block';document.getElementById('out').textContent='Error: '+(e&&e.message||e);resize()});
}
window.addEventListener('message',function(ev){
  var m=ev.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!=null&&pending[m.id]){var p=pending[m.id];delete pending[m.id];m.error?p.rej(new Error(m.error.message)):p.res(m.result);return}
  if(m.method==='ui/notifications/tool-result')show(m.params);
});
request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'unsplash-picker',version:'1.0.0'},appCapabilities:{}})
  .then(function(){notify('ui/notifications/initialized',{});resize()})
  .catch(function(){document.getElementById('msg').textContent='This app could not connect to the host.'});
</script></body></html>`

/** Register the MCP Apps picker: a tool that returns 3 candidates plus the UI that renders them. */
export function registerPickerTools(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'unsplash_picker_ui',
    PICKER_URI,
    { title: 'Unsplash photo picker', mimeType: MCP_APP_MIME },
    async () => ({
      contents: [
        {
          uri: PICKER_URI,
          mimeType: MCP_APP_MIME,
          text: PICKER_HTML,
          _meta: { ui: { csp: { resourceDomains: ['https://images.unsplash.com'] } } },
        },
      ],
    }),
  )

  server.registerTool(
    'unsplash_pick_slide_photo',
    {
      title: 'Pick an Unsplash Photo for a Slide',
      description:
        'Shows three photo candidates for a slide in an inline picker; the user clicks one and ' +
        'it is saved and its download registered (via unsplash_slide_photo). Use this when the ' +
        'user wants to choose. Searching only: nothing is downloaded until a photo is chosen. ' +
        'If the host cannot render the picker, the candidates come back as text — then call ' +
        'unsplash_slide_photo with the chosen `pick`.',
      inputSchema: pickerInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: PICKER_URI }, 'ui/resourceUri': PICKER_URI },
    },
    async (args, extra) => {
      try {
        const offset = (args.page - 1) * CANDIDATES
        // Search from page 1 up to this page so `pick` stays a stable 1-based rank.
        const res = await ctx.client.get('/search/photos', {
          params: {
            query: args.query,
            orientation: args.orientation,
            per_page: offset + CANDIDATES,
            content_filter: 'high',
          },
          signal: extra.signal,
        })
        const parsed = parseResponse(SearchPhotosResponseSchema, res.data, 'picker search')
        const photos = parsed.results.slice(offset, offset + CANDIDATES).map((p, i) => {
          const c = toCompactPhoto(p, ctx.config.appName)
          return {
            pick: offset + i + 1,
            id: c.id,
            description: p.alt_description ?? c.description,
            thumb: c.urls.small,
            credit: c.attribution.text,
          }
        })
        const payload = {
          query: args.query,
          orientation: args.orientation,
          save_dir: args.save_dir,
          offset: 0,
          photos,
        }
        return {
          ...toTextResult(JSON.stringify(payload, null, 2)),
          structuredContent: payload,
        }
      } catch (error) {
        return toToolError(error, ctx.redact)
      }
    },
  )
}
